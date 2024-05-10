// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

/**
 * D3 portion (visualization) of the ncrisc dump
 */

/* eslint no-unused-vars: [ "warn", { "argsIgnorePattern": "_" } ] */
/* eslint-disable @typescript-eslint/ban-types */
import * as d3 from 'd3';
import {
    Box,
    Coord,
    Frequency,
    HostEvent,
    Indicator,
    Line,
    PerfDumpVisProps,
    Rect,
    Unit,
    getEpochId,
    getGraphId,
    isHostDirectory,
    isNumber,
    lastElement,
    locateTooltip,
    parseOpIdentifier,
    processHostData,
    sortCores,
} from '../perf_utils';
import { NcriscDumpVisProps } from '../types';
import PerfDumpFolderMap from '../folder_map';
// import { ZoomEvent } from "d3-zoom";

class MiscInfoRect extends Rect {
    data: number;

    constructor(low: number, high: number, data: number) {
        super(low, high);
        this.data = data;
    }
}

interface QSlotCompletes {
    streams: number[];
    lines: Map<number, Line[]>;
}

interface DramReads {
    streams: number[];
    chunkReadIssued: Map<number, Line[]>;
    tilesFlushed: Map<number, Line[]>;
}

interface DramWrites {
    streams: number[];
    dramWriteSentStream: Map<number, Line[]>;
    dramWriteTileCleared: Map<number, Line[]>;
}

interface BufferStatuses {
    streams: number[];
    rects: Map<number, Rect[]>;
}

interface MiscInfo {
    streams: number[];
    rects: Map<number, MiscInfoRect[]>;
}

// CoreOp on one particular core
class CoreOp {
    loc: Coord;

    opName: string;

    folderPath: string;

    deviceId: number;

    graphId: string;

    id: string;

    epoch: number;

    // epoch
    // epoch-prologue : epoch-loop : epoch-epilogue
    // The above events will be on one horizontal timeline. epoch encompases epoch-prologue, epoch-loop, epoch-epilogue.
    // so these three can be three colored regions in a base box that is epoch.start : epoch.end units long
    epochTotal: Rect;

    epochPrologue: Rect;

    epochLoop: Rect;

    epochEpilogue: Rect;

    // vertical markers, the time is epoch-q-slot-complete-stream-x.end.
    qSlotComplete: QSlotCompletes;

    dramRead: DramReads;

    // dram-write-sent-stream-x and dram-write-tile-cleared are vertical markers on a horizontal timeline per stream.
    dramWrite: DramWrites;

    // these will be horizontal boxes. each box is from buf-available : buf-full.
    // all events will be on one horizontal timeline for one stream
    bufferStatus: BufferStatuses;

    // a box that starts at time from the time list and the box has the value displayed in it from the data list.
    // The last data:time pair will extend to the end of your time axis.
    miscInfo: MiscInfo;

    bar_height_ratio: number;

    bar_height: number;

    // global earliest start that used to normalize the timestamps
    leftBound: number;

    deviceStartCycle: number;

    deviceStartNs: number;

    unit: string;

    frequency: string;

    outOfMemory: boolean;

    feeders: string[];

    drainers: string[];

    xyOrder: boolean;

    constructor(
        name: string,
        folderPath: string,
        id: string,
        deviceId: number,
        graphId: string,
        loc: Coord,
        epoch: number,
        frequency = Frequency.DERIVED,
    ) {
        this.opName = name;
        this.folderPath = folderPath;
        this.id = id;
        this.deviceId = deviceId;
        this.graphId = graphId;
        this.loc = loc;
        this.epoch = epoch;
        this.feeders = [];
        this.drainers = [];
        this.unit = Unit.CYCLES;
        this.frequency = frequency;
    }

    getCoreString(): string {
        if (this.xyOrder) {
            return `${this.loc.y}-${this.loc.x}`;
        }
        return `${this.loc.x}-${this.loc.y}`;
    }

    sortByStream(): void {
        const sortStream = (a: number, b: number) => {
            return a - b;
        };

        if (this.qSlotComplete != undefined) {
            this.qSlotComplete.streams.sort(sortStream);
        }
        if (this.dramRead != undefined) {
            this.dramRead.streams.sort(sortStream);
        }
        if (this.dramWrite != undefined) {
            this.dramWrite.streams.sort(sortStream);
        }
        if (this.bufferStatus != undefined) {
            this.bufferStatus.streams.sort(sortStream);
        }
        if (this.miscInfo != undefined) {
            this.miscInfo.streams.sort(sortStream);
        }
    }

    checkOutOfMemory(): void {
        if (
            this.epochTotal == undefined ||
            this.epochPrologue == undefined ||
            this.epochLoop == undefined ||
            this.epochEpilogue == undefined
        ) {
            this.outOfMemory = true;
        }
    }

    hasEpochInfo(): boolean {
        return (
            this.epochTotal != undefined ||
            this.epochPrologue != undefined ||
            this.epochLoop != undefined ||
            this.epochEpilogue != undefined
        );
    }

    getNumRows(): number {
        let rows = 0;
        if (this.hasEpochInfo()) {
            rows += 1;
        }
        if (this.qSlotComplete != undefined) {
            rows += this.qSlotComplete.streams.length;
        }
        if (this.dramRead != undefined) {
            rows += this.dramRead.streams.length * 2;
        }
        if (this.dramWrite != undefined) {
            rows += this.dramWrite.streams.length * 2;
        }
        if (this.bufferStatus != undefined) {
            rows += this.bufferStatus.streams.length;
        }
        if (this.miscInfo != undefined) {
            rows += this.miscInfo.streams.length;
        }
        return rows;
    }

    earliestStart(): number {
        if (this.epochTotal != undefined) {
            return this.epochTotal.low;
        }

        let earliestStart = Infinity;
        if (this.epochPrologue != undefined) {
            earliestStart = Math.min(earliestStart, this.epochPrologue.low);
        }
        if (this.epochLoop != undefined) {
            earliestStart = Math.min(earliestStart, this.epochLoop.low);
        }
        if (this.epochEpilogue != undefined) {
            earliestStart = Math.min(earliestStart, this.epochEpilogue.low);
        }

        const earliestQslot = (streams: number[], lines: Map<number, Line[]>): void => {
            for (const stream of streams) {
                const minimum = lines.get(stream) != undefined ? lines.get(stream)![0].value : Infinity;
                earliestStart = Math.min(earliestStart, minimum);
            }
        };

        const earliestDramRead = (
            streams: number[],
            issued: Map<number, Line[]>,
            flushed: Map<number, Line[]>,
        ): void => {
            for (const stream of streams) {
                const minimum1 = issued.get(stream) != undefined ? issued.get(stream)![0].value : Infinity;
                const minimum2 = flushed.get(stream) != undefined ? flushed.get(stream)![0].value : Infinity;
                earliestStart = Math.min(earliestStart, minimum1, minimum2);
            }
        };

        const earliestDramWrite = (
            streams: number[],
            sent: Map<number, Line[]>,
            cleared: Map<number, Line[]>,
        ): void => {
            for (const stream of streams) {
                const minimum1 = sent.get(stream) != undefined ? sent.get(stream)![0].value : Infinity;
                const minimum2 = cleared.get(stream) != undefined ? cleared.get(stream)![0].value : Infinity;
                earliestStart = Math.min(earliestStart, minimum1, minimum2);
            }
        };

        const earliestBufferStatus = (streams: number[], rects: Map<number, Rect[]>): void => {
            for (const stream of streams) {
                const minimum = rects.get(stream) != undefined ? rects.get(stream)![0].low : Infinity;
                earliestStart = Math.min(earliestStart, minimum);
            }
        };

        const earliestMiscInfo = (streams: number[], rects: Map<number, MiscInfoRect[]>): void => {
            for (const stream of streams) {
                const minimum = rects.get(stream) != undefined ? rects.get(stream)![0].low : Infinity;
                earliestStart = Math.min(earliestStart, minimum);
            }
        };

        if (this.qSlotComplete != undefined) {
            earliestQslot(this.qSlotComplete.streams, this.qSlotComplete.lines);
        }
        if (this.dramRead != undefined) {
            earliestDramRead(this.dramRead.streams, this.dramRead.chunkReadIssued, this.dramRead.tilesFlushed);
        }
        if (this.dramWrite != undefined) {
            earliestDramWrite(
                this.dramWrite.streams,
                this.dramWrite.dramWriteSentStream,
                this.dramWrite.dramWriteTileCleared,
            );
        }
        if (this.bufferStatus != undefined) {
            earliestBufferStatus(this.bufferStatus.streams, this.bufferStatus.rects);
        }
        if (this.miscInfo != undefined) {
            earliestMiscInfo(this.miscInfo.streams, this.miscInfo.rects);
        }

        // console.log("EARLIEST START ")
        // console.log(earliestStart)
        return earliestStart;
    }

    latestEnd(): number {
        // console.log(this.epoch)
        if (this.epochTotal != undefined) {
            return this.epochTotal.high;
        }

        let latestEnd = 0;
        if (this.epochPrologue != undefined) {
            latestEnd = Math.max(latestEnd, this.epochPrologue.high);
        }
        if (this.epochLoop != undefined) {
            latestEnd = Math.max(latestEnd, this.epochLoop.high);
        }
        if (this.epochEpilogue != undefined) {
            latestEnd = Math.max(latestEnd, this.epochEpilogue.high);
        }

        const latestQslot = (streams: number[], lines: Map<number, Line[]>): void => {
            for (const stream of streams) {
                const maximum = lines.get(stream) != undefined ? lastElement(lines.get(stream)!).value : 0;
                latestEnd = Math.max(latestEnd, maximum);
            }
        };

        const latestDramRead = (streams: number[], issued: Map<number, Line[]>, flushed: Map<number, Line[]>): void => {
            for (const stream of streams) {
                const maximum1 = issued.get(stream) != undefined ? lastElement(issued.get(stream)!).value : 0;
                const maximum2 = flushed.get(stream) != undefined ? lastElement(flushed.get(stream)!).value : 0;
                latestEnd = Math.max(latestEnd, maximum1, maximum2);
            }
        };

        const latestDramWrite = (streams: number[], sent: Map<number, Line[]>, cleared: Map<number, Line[]>): void => {
            for (const stream of streams) {
                const maximum1 = sent.get(stream) != undefined ? lastElement(sent.get(stream)!).value : 0;
                const maximum2 = cleared.get(stream) != undefined ? lastElement(cleared.get(stream)!).value : 0;
                latestEnd = Math.max(latestEnd, maximum1, maximum2);
            }
        };

        const latestBufferStatus = (streams: number[], rects: Map<number, Rect[]>): void => {
            for (const stream of streams) {
                const maximum = rects.get(stream) != undefined ? lastElement(rects.get(stream)!).high : 0;
                latestEnd = Math.max(latestEnd, maximum);
            }
        };

        const latestMiscInfo = (streams: number[], rects: Map<number, MiscInfoRect[]>): void => {
            for (const stream of streams) {
                const maximum = rects.get(stream) != undefined ? lastElement(rects.get(stream)!).low : 0;
                latestEnd = Math.max(latestEnd, maximum);
            }
        };

        if (this.qSlotComplete != undefined) {
            latestQslot(this.qSlotComplete.streams, this.qSlotComplete.lines);
        }
        if (this.dramRead != undefined) {
            latestDramRead(this.dramRead.streams, this.dramRead.chunkReadIssued, this.dramRead.tilesFlushed);
        }
        if (this.dramWrite != undefined) {
            latestDramWrite(
                this.dramWrite.streams,
                this.dramWrite.dramWriteSentStream,
                this.dramWrite.dramWriteTileCleared,
            );
        }
        if (this.bufferStatus != undefined) {
            latestBufferStatus(this.bufferStatus.streams, this.bufferStatus.rects);
        }
        if (this.miscInfo != undefined) {
            latestMiscInfo(this.miscInfo.streams, this.miscInfo.rects);
        }

        return latestEnd;
    }

    updateMiscEndCycle(endCycle: number): void {
        if (this.miscInfo === undefined) {
            return;
        }
        // last misc info rect should end at right bound of plot
        for (const stream of this.miscInfo.streams) {
            this.miscInfo.rects.get(stream)![this.miscInfo.rects.get(stream)!.length - 1].high = endCycle;
        }
    }

    /** How much of bar region each field-plot takes */
    getBarHeightRatio(): number {
        if (this.bar_height_ratio !== undefined) {
            return this.bar_height_ratio;
        }

        if (this.getNumRows() === 0) {
            this.bar_height_ratio = 0;
        } else {
            this.bar_height_ratio = 2 / (3 * this.getNumRows());
        }

        return this.bar_height_ratio;
    }

    setLeftBound(leftBound: number): void {
        const setLeftBoundQslotComplete = () => {
            for (const stream of this.qSlotComplete.streams) {
                for (const line of this.qSlotComplete.lines.get(stream)!) {
                    line.leftBound = leftBound;
                }
            }
        };

        const setLeftBoundDramRead = () => {
            for (const stream of this.dramRead.streams) {
                for (const line of this.dramRead.chunkReadIssued.get(stream)!) {
                    line.leftBound = leftBound;
                }
                for (const line of this.dramRead.tilesFlushed.get(stream)!) {
                    line.leftBound = leftBound;
                }
            }
        };

        const setLeftBoundDramWrite = () => {
            for (const stream of this.dramWrite.streams) {
                for (const line of this.dramWrite.dramWriteSentStream.get(stream)!) {
                    line.leftBound = leftBound;
                }
                for (const line of this.dramWrite.dramWriteTileCleared.get(stream)!) {
                    line.leftBound = leftBound;
                }
            }
        };

        const setLeftBoundBufferStatus = () => {
            for (const stream of this.bufferStatus.streams) {
                for (const rect of this.bufferStatus.rects.get(stream)!) {
                    rect.leftBound = leftBound;
                }
            }
        };

        const setLeftBoundMiscInfo = () => {
            for (const stream of this.miscInfo.streams) {
                for (const rect of this.miscInfo.rects.get(stream)!) {
                    rect.leftBound = leftBound;
                }
            }
        };

        this.leftBound = leftBound;
        if (this.epochTotal != undefined) {
            this.epochTotal.leftBound = leftBound;
        }
        if (this.epochPrologue != undefined) {
            this.epochPrologue.leftBound = leftBound;
        }
        if (this.epochLoop != undefined) {
            this.epochLoop.leftBound = leftBound;
        }
        if (this.epochEpilogue != undefined) {
            this.epochEpilogue.leftBound = leftBound;
        }
        this.qSlotComplete != undefined && setLeftBoundQslotComplete();
        this.dramRead != undefined && setLeftBoundDramRead();
        this.dramWrite != undefined && setLeftBoundDramWrite();
        this.bufferStatus != undefined && setLeftBoundBufferStatus();
        this.miscInfo != undefined && setLeftBoundMiscInfo();
    }

    // op data recorded in cycles
    populateHostInfo(hostToDeviceMap: Record<string, number>): void {
        if (hostToDeviceMap == undefined) {
            // console.error("Op: undefined host to device map when populating host info.");
            return;
        }

        const populateHostInfoQslotComplete = () => {
            // populate host info for q slot completes
            for (const stream of this.qSlotComplete.streams) {
                for (const line of this.qSlotComplete.lines.get(stream)!) {
                    line.populateHostInfo(hostToDeviceMap);
                }
            }
        };
        const populateHostInfoDramRead = () => {
            // populate host info for dram reads
            for (const stream of this.dramRead.streams) {
                for (const line of this.dramRead.chunkReadIssued.get(stream)!) {
                    line.populateHostInfo(hostToDeviceMap);
                }
                for (const line of this.dramRead.tilesFlushed.get(stream)!) {
                    line.populateHostInfo(hostToDeviceMap);
                }
            }
        };

        const populateHostInfoDramWrite = () => {
            // populate host info for dram writes
            for (const stream of this.dramWrite.streams) {
                for (const line of this.dramWrite.dramWriteSentStream.get(stream)!) {
                    line.populateHostInfo(hostToDeviceMap);
                }
                for (const line of this.dramWrite.dramWriteTileCleared.get(stream)!) {
                    line.populateHostInfo(hostToDeviceMap);
                }
            }
        };

        const populateHostInfoBufferStatus = () => {
            // populate host info for buffer status bars
            for (const stream of this.bufferStatus.streams) {
                for (const rect of this.bufferStatus.rects.get(stream)!) {
                    rect.populateHostInfo(hostToDeviceMap);
                }
            }
        };

        const populateHostInfoMiscInfo = () => {
            for (const stream of this.miscInfo.streams) {
                for (const rect of this.miscInfo.rects.get(stream)!) {
                    rect.populateHostInfo(hostToDeviceMap);
                }
            }
        };

        this.deviceStartCycle = hostToDeviceMap['start-cycle'];
        this.deviceStartNs = hostToDeviceMap['start-ns'];
        this.epochTotal != undefined && this.epochTotal.populateHostInfo(hostToDeviceMap);
        this.epochPrologue != undefined && this.epochPrologue.populateHostInfo(hostToDeviceMap);
        this.epochLoop != undefined && this.epochLoop.populateHostInfo(hostToDeviceMap);
        this.epochEpilogue != undefined && this.epochEpilogue.populateHostInfo(hostToDeviceMap);
        this.qSlotComplete != undefined && populateHostInfoQslotComplete();
        this.dramRead != undefined && populateHostInfoDramRead();
        this.dramWrite != undefined && populateHostInfoDramWrite();
        this.bufferStatus != undefined && populateHostInfoBufferStatus();
        this.miscInfo != undefined && populateHostInfoMiscInfo();
    }

    // create data structures to store data for each unit.
    populateUnitData(): void {
        const populateUnitDataQslotComplete = () => {
            for (const stream of this.qSlotComplete.streams) {
                for (const line of this.qSlotComplete.lines.get(stream)!) {
                    line.populateUnitData();
                }
            }
        };

        const populateUnitDataDramRead = () => {
            for (const stream of this.dramRead.streams) {
                for (const line of this.dramRead.chunkReadIssued.get(stream)!) {
                    line.populateUnitData();
                }
                for (const line of this.dramRead.tilesFlushed.get(stream)!) {
                    line.populateUnitData();
                }
            }
        };

        const populateUnitDataDramWrite = () => {
            for (const stream of this.dramWrite.streams) {
                for (const line of this.dramWrite.dramWriteSentStream.get(stream)!) {
                    line.populateUnitData();
                }
                for (const line of this.dramWrite.dramWriteTileCleared.get(stream)!) {
                    line.populateUnitData();
                }
            }
        };

        const populateUnitDataBufferStatus = () => {
            for (const stream of this.bufferStatus.streams) {
                for (const rect of this.bufferStatus.rects.get(stream)!) {
                    rect.populateUnitData();
                }
            }
        };

        const populateUnitDataMiscInfo = () => {
            for (const stream of this.miscInfo.streams) {
                for (const rect of this.miscInfo.rects.get(stream)!) {
                    rect.populateUnitData();
                }
            }
        };

        this.epochTotal != undefined && this.epochTotal.populateUnitData();
        this.epochPrologue != undefined && this.epochPrologue.populateUnitData();
        this.epochLoop != undefined && this.epochLoop.populateUnitData();
        this.epochEpilogue != undefined && this.epochEpilogue.populateUnitData();
        this.qSlotComplete != undefined && populateUnitDataQslotComplete();
        this.dramRead != undefined && populateUnitDataDramRead();
        this.dramWrite != undefined && populateUnitDataDramWrite();
        this.bufferStatus != undefined && populateUnitDataBufferStatus();
        this.miscInfo != undefined && populateUnitDataMiscInfo();
    }

    switchToFrequency(frequency: string): void {
        if (!Object.values(Frequency).includes(frequency as Frequency)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }

        const switchToFrequencyQslotComplete = () => {
            for (const stream of this.qSlotComplete.streams) {
                for (const line of this.qSlotComplete.lines.get(stream)!) {
                    line.switchToFrequency(frequency);
                }
            }
        };

        const switchToFrequencyDramRead = () => {
            for (const stream of this.dramRead.streams) {
                for (const line of this.dramRead.chunkReadIssued.get(stream)!) {
                    line.switchToFrequency(frequency);
                }
                for (const line of this.dramRead.tilesFlushed.get(stream)!) {
                    line.switchToFrequency(frequency);
                }
            }
        };

        const switchToFrequencyDramWrite = () => {
            for (const stream of this.dramWrite.streams) {
                for (const line of this.dramWrite.dramWriteSentStream.get(stream)!) {
                    line.switchToFrequency(frequency);
                }
                for (const line of this.dramWrite.dramWriteTileCleared.get(stream)!) {
                    line.switchToFrequency(frequency);
                }
            }
        };

        const switchToFrequencyBufferStatus = () => {
            for (const stream of this.bufferStatus.streams) {
                for (const rect of this.bufferStatus.rects.get(stream)!) {
                    rect.switchToFrequency(frequency);
                }
            }
        };

        const switchToFrequencyMiscInfo = () => {
            for (const stream of this.miscInfo.streams) {
                for (const rect of this.miscInfo.rects.get(stream)!) {
                    rect.switchToFrequency(frequency);
                }
            }
        };

        this.epochTotal != undefined && this.epochTotal.switchToFrequency(frequency);
        this.epochPrologue != undefined && this.epochPrologue.switchToFrequency(frequency);
        this.epochLoop != undefined && this.epochLoop.switchToFrequency(frequency);
        this.epochEpilogue != undefined && this.epochEpilogue.switchToFrequency(frequency);
        this.qSlotComplete != undefined && switchToFrequencyQslotComplete();
        this.dramRead != undefined && switchToFrequencyDramRead();
        this.dramWrite != undefined && switchToFrequencyDramWrite();
        this.bufferStatus != undefined && switchToFrequencyBufferStatus();
        this.miscInfo != undefined && switchToFrequencyMiscInfo();

        // console.log("DRAM WRITE SENT: ", this.dramWriteSent)

        // console.log(`BOUNDS IN SWITCH TO UNIT ${unit}: `, this.bounds)
        this.frequency = frequency;
    }

    switchToUnit(unit: string): void {
        if (!Object.values(Unit).includes(unit as Unit)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }

        const switchToUnitQslotComplete = () => {
            for (const stream of this.qSlotComplete.streams) {
                for (const line of this.qSlotComplete.lines.get(stream)!) {
                    line.switchToUnit(unit);
                }
            }
        };

        const switchToUnitDramRead = () => {
            for (const stream of this.dramRead.streams) {
                for (const line of this.dramRead.chunkReadIssued.get(stream)!) {
                    line.switchToUnit(unit);
                }
                for (const line of this.dramRead.tilesFlushed.get(stream)!) {
                    line.switchToUnit(unit);
                }
            }
        };

        const switchToUnitDramWrite = () => {
            for (const stream of this.dramWrite.streams) {
                for (const line of this.dramWrite.dramWriteSentStream.get(stream)!) {
                    line.switchToUnit(unit);
                }
                for (const line of this.dramWrite.dramWriteTileCleared.get(stream)!) {
                    line.switchToUnit(unit);
                }
            }
        };

        const switchToUnitBufferStatus = () => {
            for (const stream of this.bufferStatus.streams) {
                for (const rect of this.bufferStatus.rects.get(stream)!) {
                    rect.switchToUnit(unit);
                }
            }
        };

        const switchToUnitMiscInfo = () => {
            for (const stream of this.miscInfo.streams) {
                for (const rect of this.miscInfo.rects.get(stream)!) {
                    rect.switchToUnit(unit);
                }
            }
        };

        this.epochTotal != undefined && this.epochTotal.switchToUnit(unit);
        this.epochPrologue != undefined && this.epochPrologue.switchToUnit(unit);
        this.epochLoop != undefined && this.epochLoop.switchToUnit(unit);
        this.epochEpilogue != undefined && this.epochEpilogue.switchToUnit(unit);
        this.qSlotComplete != undefined && switchToUnitQslotComplete();
        this.dramRead != undefined && switchToUnitDramRead();
        this.dramWrite != undefined && switchToUnitDramWrite();
        this.bufferStatus != undefined && switchToUnitBufferStatus();
        this.miscInfo != undefined && switchToUnitMiscInfo();

        // console.log("DRAM WRITE SENT: ", this.dramWriteSent)

        // console.log(`BOUNDS IN SWITCH TO UNIT ${unit}: `, this.bounds)
        this.unit = unit;
    }
}

export default class NcriscD3Controller {
    d3Ref: HTMLDivElement;

    visProps: PerfDumpVisProps;

    ncriscVisProps: NcriscDumpVisProps;

    folderMap: PerfDumpFolderMap;

    allFields: string[];

    data: Map<string, Record<string, any>>; // perf dump data

    hostData: Map<string, Record<string, any>> | null; // host event data

    allFolderPaths: string[];

    allProcesses: string[];

    folderPaths: string[];

    svg: any; // main SVG reference

    plotSvg: any; // SVG that contains bars and x axis, child of main SVG reference

    legend: any;

    zoom: any; // reference to zoom transformer

    zoomScale: number;

    unit: string;

    frequency: string;

    // references to various groups of elements that need to be moved, zoomed, etc.
    opBars: any; // "g" element holding op bars

    opNames: any; // "g" element holding op names

    streams: any; // "g" element holding streams

    xAxisg: any; // "g" element holding X axis

    opColors: Object;

    hostEventColors: CallableFunction;

    // Ops
    folderPathAllCoreOpsMap: { [folderPath: string]: CoreOp[] }; // folderPathAllCoreOpsMap[folderPath] = [coreOps of that folderPath]

    coreOpsToPlot: { [core: string]: CoreOp[] }; // coreOps to be plotted, subset of folderPathAllCoreOpsMap, coreOpsToPlot[core] = [coreOps of that core]

    cores: string[]; // sorted cores to be plotted, keys of coreOpsToPlot

    selectedCores: string[];

    selectedFields: string[];

    hostEventMap: Record<string, HostEvent[]>;

    hostEventsToPlot: HostEvent[];

    folderPathHostToDeviceMap: Record<string, Record<number, Record<string, number>>>;

    hostEventCoreOpIndexMap: Record<string, number>;

    // Bounds of the chart, based on what was found in the data
    startCycle: number;

    endCycle: number;

    // original and current X scale
    xScale: any;

    currentXScale: any;

    xAxis: any;

    domain: [number, number];

    showHost: boolean;

    // Draw parameters
    static MARGIN_TOP = 1; // margin at the top of the whole chart

    static MARGIN_BOTTOM = 10; // margin at the bottom of the whole chart

    static MARGIN_LEFT = 400; // margin on the left, for op names and other info

    static MARGIN_RIGHT = 30; // margin on the right, for scroll bar

    static MARGIN_SHIFT_DOWN = 20;

    FULL_W: number; // width and height of the area in which bars/lines are drawn

    FULL_H: number;

    BAR_REGION_HEIGHT: number; // height of space for one op

    constructor(
        d3Ref: HTMLDivElement,
        visProps: PerfDumpVisProps,
        folderMap: PerfDumpFolderMap,
        ncriscVisProps: NcriscDumpVisProps,
        data: Map<string, Record<string, any>>,
        hostData: Map<string, Record<string, any>> | null,
    ) {
        this.d3Ref = d3Ref;
        this.visProps = visProps;
        this.folderMap = folderMap;
        this.ncriscVisProps = ncriscVisProps;
        this.data = data;
        this.hostData = hostData;
        // console.log("NCRISC VIS PROPS");
        // console.log(ncriscVisProps);
        this.opColors = {
            Total_Epoch: 'slateblue',
            Epoch_Loop: 'green',
            Epoch_Prologue: '#ffff66',
            Epoch_Epilogue: '#ffff66',
            Qslot_Complete: '#33ccff',
            Dram_Read_Chunk_Read_Issued: '#ff00ff',
            Dram_Read_Tiles_Flushed: '#ff99ff',
            Dram_Write_Tiles_Sent: '#668cff',
            Dram_Write_Tiles_Cleared: '#666699',
            Buffer_Status: '#cc6600',
            Misc_Info: '#ec7063',
        };
        // console.log("NCRISC PROPS: ", this.ncriscVisProps);
        //
        // Process data
        //
        this.allFields = [
            'Total Epoch',
            'Epoch Prologue',
            'Epoch Loop',
            'Epoch Epilogue',
            'Qslot Complete',
            'Dram Read Chunk Read Issued',
            'Dram Read Tiles Flushed',
            'Dram Write Tiles Sent',
            'Dram Write Tiles Cleared',
            'Buffer Status',
            'Misc Info',
        ];

        // console.log("Host Data: ", hostData);
        this.unit = this.visProps.unit;
        this.frequency = this.visProps.frequency;
        this.allFolderPaths = this.folderMap.allFolderPaths.map((folderPath: string[]) => folderPath.join('/'));
        this.setFolderPaths();
        this.setSelectedCores();
        this.setSelectedFields();
        this.processData();
        this.setAllProcesses();
        this.hostEventColors = d3
            .scaleLinear<string, number, unknown>()
            .domain([0, Math.max(this.allProcesses.length - 1, 1)])
            .range(['#89CFF0', '#5D3FD3']);

        this.frequency = Frequency.DERIVED;
        this.unit = Unit.CYCLES;

        if (this.frequency != this.visProps.frequency) {
            this.frequency = this.visProps.frequency;
            for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
                this.folderPathAllCoreOpsMap[folderPath].forEach((coreOp: CoreOp) =>
                    coreOp.switchToFrequency(this.frequency),
                );
            }
        }
        if (this.unit != this.visProps.unit) {
            this.unit = this.visProps.unit;
            for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
                this.folderPathAllCoreOpsMap[folderPath].forEach((coreOp: CoreOp) => coreOp.switchToUnit(this.unit));
            }
        }
        this.filterCoreOpsAndHostEvents();
        this.calculateFixedBounds();
        this.calculateDrawingParameters();
        this.draw();

        this.updateXYOrder(this.visProps);

        // // Set variable parmeters
        // this.update(visProps);
    }

    setFolderPaths(): void {
        // if(this.visProps.selectedEpochs.includes("Show All Epochs")){
        //   this.folderPaths = this.allFolderPaths;
        // }
        this.folderPaths = this.visProps.selectedFolderPaths
            .map((folderPath: string[]) => folderPath.join('/'))
            .filter(
                (folderPath: string) =>
                    getGraphId(folderPath) != '' || getEpochId(folderPath) != '' || isHostDirectory(folderPath),
            );

        this.allFolderPaths = this.folderMap.allFolderPaths
            .filter((folderPath: string[]) => lastElement(folderPath) == 'host')
            .map((folderPath: string[]) => folderPath.join('/'))
            .concat(this.folderPaths.filter((folderPath: string) => !isHostDirectory(folderPath)));
    }

    // setCores(): void {
    //   if (this.ncriscVisProps.selectedCores.includes("Show All Cores")) {
    //     this.coresToPlot =
    //   }
    // }

    setAllProcesses(): void {
        this.allProcesses = [];
        for (const folderPath of Object.keys(this.hostEventMap)) {
            for (const hostEvent of this.hostEventMap[folderPath]) {
                hostEvent.process != undefined &&
                    !this.allProcesses.includes(hostEvent.process) &&
                    this.allProcesses.push(hostEvent.process);
            }
        }
        this.allProcesses.sort((a: string, b: string) => parseInt(a) - parseInt(b));
    }

    setSelectedCores(): void {
        if (this.ncriscVisProps.selectedCores.includes('Show All Cores')) {
            this.selectedCores = this.ncriscVisProps.allCores.filter((core: string) => core != 'Show All Cores');
        } else {
            this.selectedCores = [...this.ncriscVisProps.selectedCores];
        }
    }

    setSelectedFields(): void {
        if (this.ncriscVisProps.selectedFields.includes('Show All Fields')) {
            this.selectedFields = this.ncriscVisProps.allFields.filter((field: string) => field != 'Show All Fields');
        } else {
            this.selectedFields = [...this.ncriscVisProps.selectedFields];
        }
    }

    sortHostEvents(): void {
        for (const folderPath of Object.keys(this.hostEventMap)) {
            this.hostEventMap[folderPath].sort((a: HostEvent, b: HostEvent) => {
                if (a.process != b.process) {
                    return parseInt(a.process) - parseInt(b.process);
                }
                return a.latestEnd - b.latestEnd;
            });
        }
    }

    // filter all core ops by checking if we want to plot certain cores and fields
    // store filtered core ops in this.coreOpsToPlot for plotting
    filterCoreOpsAndHostEvents(): void {
        // console.log("FOLDER PATHS IN FILTER CORE OPS:", this.folderPaths);
        // console.log("THIS.FOLDER PATHS", this.folderPaths);
        this.coreOpsToPlot = {}; // {core: [coreOps]}
        this.hostEventsToPlot = [];
        this.hostEventCoreOpIndexMap = {};
        this.cores = [];
        for (const folderPath of this.folderPaths) {
            if (isHostDirectory(folderPath)) {
                this.hostEventsToPlot = this.hostEventsToPlot.concat(this.hostEventMap[folderPath]);
                continue;
            }
            if (!Array.isArray(this.folderPathAllCoreOpsMap[folderPath])) {
                continue;
            }
            const coreOps = this.folderPathAllCoreOpsMap[folderPath];
            for (const coreOp of coreOps) {
                coreOp.xyOrder = this.visProps.xyOrder;
                const core = coreOp.getCoreString();
                if (!this.shouldPlotCore(core)) {
                    continue;
                }
                if (Array.isArray(this.coreOpsToPlot[core])) {
                    this.coreOpsToPlot[core].push(coreOp);
                } else {
                    this.coreOpsToPlot[core] = [coreOp];
                }
            }
        }

        for (const core of Object.keys(this.coreOpsToPlot)) {
            this.coreOpsToPlot[core] = this.coreOpsToPlot[core].filter((coreOp: CoreOp) => coreOp.getNumRows() > 0);
            if (this.coreOpsToPlot[core].length == 0) {
                delete this.coreOpsToPlot[core];
            }
        }
        this.cores = Object.keys(this.coreOpsToPlot);
        this.cores.sort(sortCores);

        let index = 0;
        for (const hostEvent of this.hostEventsToPlot) {
            this.hostEventCoreOpIndexMap[hostEvent.fullName] = index;
            index += 1;
        }
        for (const core of this.cores) {
            for (const coreOp of this.coreOpsToPlot[core]) {
                this.hostEventCoreOpIndexMap[coreOp.id] = index;
            }
            index += 1;
        }
    }

    calculateDrawingParameters(): void {
        const rows = this.hostEventsToPlot.length + Object.keys(this.coreOpsToPlot).length;
        // Calculate drawing parameters
        NcriscD3Controller.MARGIN_TOP = this.visProps.barRegionHeight / 80;
        this.FULL_W = this.visProps.width - NcriscD3Controller.MARGIN_LEFT;
        this.BAR_REGION_HEIGHT = this.visProps.barRegionHeight;
        const panelHeight = this.visProps.height - NcriscD3Controller.MARGIN_SHIFT_DOWN;
        this.FULL_H = Math.max(panelHeight, this.BAR_REGION_HEIGHT * rows);
        // console.log("NUMBER OF OPS")
        // console.log(this.coreOpsToPlot.length)

        for (const hostEvent of this.hostEventsToPlot) {
            hostEvent.barHeight = this.BAR_REGION_HEIGHT * hostEvent.getBarHeightRatio();
        }

        for (const coreOps of Object.values(this.coreOpsToPlot)) {
            for (const coreOp of coreOps) {
                coreOp.bar_height = this.BAR_REGION_HEIGHT * coreOp.getBarHeightRatio();
            }
        }
    }

    // on folder path changes.
    updateFolderPaths(newVisProps: PerfDumpVisProps, newNcriscProps: NcriscDumpVisProps): void {
        // this.close();
        const oldFolderPaths = this.visProps.selectedFolderPaths.map((folderPath: string[]) => folderPath.join('/'));
        const newFolderPaths = newVisProps.selectedFolderPaths.map((folderPath: string[]) => folderPath.join('/'));
        this.visProps = newVisProps;
        this.ncriscVisProps = newNcriscProps;
        this.setFolderPaths();
        const domain = this.currentXScale.domain();
        const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
        this.plotSvg.selectAll('#cycleIndicator').remove();
        d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
        this.plotSvg.selectAll('#timePoint').remove();
        if (newFolderPaths.length > oldFolderPaths.length) {
            const newSelectedPath = newFolderPaths.filter((folderPath: string) => !oldFolderPaths.includes(folderPath));
            console.assert(
                newSelectedPath.length == 1,
                'Ncrisc dump: Difference when a new folder path is selected should be strictly 1.',
            );
            if (isHostDirectory(newSelectedPath[0])) {
                const newHostEventsToPlot = this.hostEventMap[newSelectedPath[0]];
                if (!newHostEventsToPlot || newHostEventsToPlot.length == 0) {
                    console.error('Ncrisc dump: null or empty new host events.');
                    return;
                }
                this.filterCoreOpsAndHostEvents();
                this.calculateFixedBounds();
                this.calculateDrawingParameters();
                this.updatePlotHeight();
                this.reDrawOnHostEventSelect(newHostEventsToPlot);
                this.zoomToDomain(domain);
                indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
                return;
            }
            this.setSelectedCores();
            this.handleSelectFolderPath(newSelectedPath[0]);
            const newCoreOpsToPlot: Record<string, CoreOp[]> = {};
            // TODO: Add error checking
            const coreOps = this.folderPathAllCoreOpsMap[newSelectedPath[0]];
            if (!Array.isArray(coreOps) || coreOps.length == 0) {
                console.error('Ncrisc dump: null or empty new core ops to plot.');
                return;
            }
            for (const coreOp of coreOps) {
                const core = coreOp.getCoreString();
                if (!this.shouldPlotCore(core)) {
                    continue;
                }
                if (Array.isArray(newCoreOpsToPlot[core])) {
                    newCoreOpsToPlot[core].push(coreOp);
                } else {
                    newCoreOpsToPlot[core] = [coreOp];
                }
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateFixedBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpSelect(newCoreOpsToPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        } else if (newFolderPaths.length < oldFolderPaths.length) {
            const deSelectedPath = oldFolderPaths.filter((folderPath: string) => !newFolderPaths.includes(folderPath));
            console.assert(
                deSelectedPath.length == 1,
                'Ncrisc dump: Difference when a new folder path is deselected should be strictly 1.',
            );
            if (isHostDirectory(deSelectedPath[0])) {
                const hostEventsToRemoveFromPlot = this.hostEventMap[deSelectedPath[0]];
                if (!hostEventsToRemoveFromPlot || hostEventsToRemoveFromPlot.length == 0) {
                    console.error('Ncrisc dump: null or empty new host events.');
                    return;
                }
                this.filterCoreOpsAndHostEvents();
                this.calculateFixedBounds();
                this.calculateDrawingParameters();
                this.updatePlotHeight();
                this.reDrawOnHostEventDeselect(hostEventsToRemoveFromPlot);
                this.zoomToDomain(domain);
                indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
                return;
            }
            this.setSelectedCores();
            const coreOpsToRemoveFromPlot: CoreOp[] = this.folderPathAllCoreOpsMap[deSelectedPath[0]];
            delete this.folderPathAllCoreOpsMap[deSelectedPath[0]];
            if (!coreOpsToRemoveFromPlot || coreOpsToRemoveFromPlot.length == 0) {
                console.error('Ncrisc dump: null or empty core ops to remove.');
                return;
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateFixedBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpDeselect(coreOpsToRemoveFromPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        }
        // this.filterCoreOpsAndHostEvents();
        // this.calculateFixedBounds();
        // this.calculateDrawingParameters();
        // this.draw();
        // const end = performance.now()
        // console.log("TIME DURATION: " + String(end - start))
    }

    updateCores(ncriscVisProps: NcriscDumpVisProps): void {
        const oldCores = this.selectedCores;
        this.ncriscVisProps = ncriscVisProps;
        this.setSelectedCores();
        const newCores = this.selectedCores;
        const domain = this.currentXScale.domain();
        // if user selected new cores
        if (newCores.length > oldCores.length) {
            const newCoreOpsToPlot: Record<string, CoreOp[]> = {};
            const newSelectedCores = newCores.filter((core: string) => !oldCores.includes(core));
            for (const folderPath of this.folderPaths) {
                if (isHostDirectory(folderPath)) {
                    continue;
                }
                for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                    const core = coreOp.getCoreString();
                    if (!newSelectedCores.includes(core)) {
                        continue;
                    }
                    if (Array.isArray(newCoreOpsToPlot[core])) {
                        newCoreOpsToPlot[core].push(coreOp);
                    } else {
                        newCoreOpsToPlot[core] = [coreOp];
                    }
                }
            }
            if (Object.keys(newCoreOpsToPlot).length == 0) {
                console.warn('Ncrisc dump: null or empty new ops in new input selection.');
                return;
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.resetZoom();
            this.reDrawOnOpSelect(newCoreOpsToPlot, false);
            this.zoomToDomain(domain);
        }
        // if user deselected cores
        else if (newCores.length < oldCores.length) {
            const deSelectedCores = oldCores.filter((core: string) => !newCores.includes(core));
            const coreOpsToRemoveFromPlot: CoreOp[] = [];
            for (const folderPath of this.folderPaths) {
                if (isHostDirectory(folderPath)) {
                    continue;
                }
                for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                    const core = coreOp.getCoreString();
                    if (deSelectedCores.includes(core)) {
                        coreOpsToRemoveFromPlot.push(coreOp);
                    }
                }
            }
            if (coreOpsToRemoveFromPlot.length == 0) {
                return;
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.resetZoom();
            this.reDrawOnOpDeselect(coreOpsToRemoveFromPlot, false);
            this.zoomToDomain(domain);
        }
    }

    // On cores, fields changes.
    updateFields(ncriscProps: NcriscDumpVisProps): void {
        const oldFields = this.selectedFields;
        this.ncriscVisProps = ncriscProps;
        this.setSelectedFields();
        const newFields = this.selectedFields;
        const domain = this.currentXScale.domain();
        if (newFields.length > oldFields.length) {
            // console.log("OLD DOMAIN: ", domain);
            this.resetZoom();
            // console.log("NEW DOMAIN: ", this.currentXScale.domain());
            const newFieldsToPlot = newFields.filter((field: string) => !oldFields.includes(field));
            const regions = this.opBars.selectAll('.g-core-ops');
            if (newFieldsToPlot.includes('Total Epoch')) {
                this.createEpochTotalBars(regions);
                this.updateEpochTotalBars(regions, this.coreOpsToPlot);
            }

            if (newFieldsToPlot.includes('Epoch Loop')) {
                this.createEpochLoopBars(regions);
                this.updateEpochLoopBars(regions, this.coreOpsToPlot);
            }
            if (newFieldsToPlot.includes('Epoch Prologue')) {
                this.createEpochPrologueBars(regions);
                this.updateEpochPrologueBars(regions, this.coreOpsToPlot);
            }
            if (newFieldsToPlot.includes('Epoch Epilogue')) {
                this.createEpochEpilogueBars(regions);
                this.updateEpochEpilogueBars(regions, this.coreOpsToPlot);
            }
            if (newFieldsToPlot.includes('Qslot Complete')) {
                this.createQslotLines(regions);
                this.updateQslotLines(regions, this.coreOpsToPlot);
            }
            if (newFieldsToPlot.includes('Dram Read')) {
                this.createDramReadLines(regions);
                this.updateDramReadLines(regions, this.coreOpsToPlot);
            }
            if (newFieldsToPlot.includes('Dram Write')) {
                this.createDramWriteLines(regions);
                this.updateDramWriteLines(regions, this.coreOpsToPlot);
            }
            if (newFieldsToPlot.includes('Buffer Status')) {
                this.createBufferStatusBars(regions);
                this.updateBufferStatusBars(regions, this.coreOpsToPlot);
            }
            if (newFieldsToPlot.includes('Misc Info')) {
                this.createMiscInfoBars(regions);
                this.updateMiscInfoBars(regions, this.coreOpsToPlot);
            }
            this.zoomToDomain(domain);
        } else if (newFields.length < oldFields.length) {
            const fieldsToRemoveFromPlot = oldFields.filter((field: string) => !newFields.includes(field));
            fieldsToRemoveFromPlot.includes('Total Epoch') && this.opBars.selectAll('#epoch-total').remove();
            fieldsToRemoveFromPlot.includes('Epoch Loop') && this.opBars.selectAll('#epoch-loop').remove();
            fieldsToRemoveFromPlot.includes('Epoch Prologue') && this.opBars.selectAll('#epoch-prologue').remove();
            fieldsToRemoveFromPlot.includes('Epoch Epilogue') && this.opBars.selectAll('#epoch-epilogue').remove();
            fieldsToRemoveFromPlot.includes('Qslot Complete') && this.opBars.selectAll('#q-slot-complete').remove();
            if (fieldsToRemoveFromPlot.includes('Dram Read')) {
                this.opBars.selectAll('#dram-read-issued').remove();
                this.opBars.selectAll('#dram-read-flushed').remove();
            }
            if (fieldsToRemoveFromPlot.includes('Dram Write')) {
                this.opBars.selectAll('#dram-write-sent').remove();
                this.opBars.selectAll('#dram-write-cleared').remove();
            }
            fieldsToRemoveFromPlot.includes('Buffer Status') && this.opBars.selectAll('#buffer-status').remove();
            fieldsToRemoveFromPlot.includes('Misc Info') && this.opBars.selectAll('#misc-info').remove();
        }
    }

    // on height, width changes.
    resizeSVG(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        const domain = this.currentXScale.domain();
        const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
        this.plotSvg.selectAll('#cycleIndicator').remove();
        d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
        this.plotSvg.selectAll('#timePoint').remove();
        this.calculateDrawingParameters();
        this.redrawOnResize();
        this.zoomToDomain(domain);
        indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
    }

    // on bar height changes.
    // TODO: update to improve performance
    updateBarHeight(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        const domain = this.currentXScale.domain();
        this.calculateDrawingParameters();
        this.updatePlotHeight();
        const qSlotCompleteTop = (coreOp: CoreOp, qslotId: number): number => {
            let epoch_bar_height = 0;
            const prev_q_slot_bar_height = qslotId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            const prevBarHeights = epoch_bar_height + prev_q_slot_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };
        const dramReadIssuedTop = (coreOp: CoreOp, dramReadIssuedId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            // assuming each dram read stream has chunkReadIssued and tilesFlushed
            const prev_dram_read_bar_height =
                2 * (dramReadIssuedId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            const prevBarHeights = epoch_bar_height + qslot_bar_height + prev_dram_read_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        const dramWriteTileSentTop = (coreOp: CoreOp, dramWriteSentId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            let dram_read_bar_height = 0;
            // assuming exists tile sent and tile cleared for each dram write stream
            const prev_write_bar_height = 2 * (dramWriteSentId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            if (coreOp.dramRead !== undefined) {
                dram_read_bar_height =
                    2 * (coreOp.dramRead.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            const prevBarHeights = epoch_bar_height + qslot_bar_height + dram_read_bar_height + prev_write_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        const bufferStatusTop = (coreOp: CoreOp, bufferStatusId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            let dram_read_bar_height = 0;
            let dram_write_bar_height = 0;
            const prev_buffer_status_bar_height = bufferStatusId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            if (coreOp.dramRead !== undefined) {
                dram_read_bar_height =
                    2 * (coreOp.dramRead.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            if (coreOp.dramWrite !== undefined) {
                dram_write_bar_height =
                    2 * (coreOp.dramWrite.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            const prevBarHeights =
                epoch_bar_height +
                qslot_bar_height +
                dram_read_bar_height +
                dram_write_bar_height +
                prev_buffer_status_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        const miscInfoTop = (coreOp: CoreOp, miscInfoId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            let dram_read_bar_height = 0;
            let dram_write_bar_height = 0;
            let buffer_status_bar_height = 0;
            const prev_misc_info_bar_height = miscInfoId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            if (coreOp.dramRead !== undefined) {
                dram_read_bar_height =
                    2 * (coreOp.dramRead.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            if (coreOp.dramWrite !== undefined) {
                dram_write_bar_height =
                    2 * (coreOp.dramWrite.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            if (coreOp.bufferStatus !== undefined) {
                buffer_status_bar_height =
                    coreOp.bufferStatus.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            const prevBarHeights =
                epoch_bar_height +
                qslot_bar_height +
                dram_read_bar_height +
                dram_write_bar_height +
                buffer_status_bar_height +
                prev_misc_info_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };
        // host events
        for (const event of this.hostEventsToPlot) {
            this.opBars
                .selectAll(`.host-event-${event.id}`)
                .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_TOP)
                .attr('height', event.barHeight);
        }
        // epoch total, loop, prologue, epilogue
        this.opBars
            .selectAll('.ncrisc-dump-op-element')
            .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_TOP)
            .attr('height', (coreOp: CoreOp) => coreOp.bar_height);

        for (const core of Object.keys(this.coreOpsToPlot)) {
            for (const coreOp of this.coreOpsToPlot[core]) {
                // q slot completes
                if (coreOp.qSlotComplete !== undefined) {
                    for (let c = 0; c < coreOp.qSlotComplete.streams.length; c++) {
                        const stream = coreOp.qSlotComplete.streams[c];
                        this.opBars
                            .selectAll(`.q-slot-complete-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('y1', qSlotCompleteTop(coreOp, c))
                            .attr('y2', qSlotCompleteTop(coreOp, c) + coreOp.bar_height);
                    }
                }
                // dram read
                if (coreOp.dramRead != undefined) {
                    for (let c = 0; c < coreOp.dramRead.streams.length; c++) {
                        const stream = coreOp.dramRead.streams[c];

                        this.opBars
                            .selectAll(`.dram-read-issued-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('y1', dramReadIssuedTop(coreOp, c))
                            .attr('y2', dramReadIssuedTop(coreOp, c) + coreOp.bar_height);

                        this.opBars
                            .selectAll(`.dram-read-flushed-core-op-${coreOp.id}-stream-${stream}`)
                            .attr(
                                'y1',
                                dramReadIssuedTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + coreOp.bar_height,
                            )
                            .attr(
                                'y2',
                                dramReadIssuedTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + 2 * coreOp.bar_height,
                            );
                    }
                }

                if (coreOp.dramWrite !== undefined) {
                    for (let c = 0; c < coreOp.dramWrite.streams.length; c++) {
                        const stream = coreOp.dramWrite.streams[c];
                        this.opBars
                            .selectAll(`.dram-write-sent-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('y1', dramWriteTileSentTop(coreOp, c))
                            .attr('y2', dramWriteTileSentTop(coreOp, c) + coreOp.bar_height);
                        this.opBars
                            .selectAll(`.dram-write-cleared-core-op-${coreOp.id}-stream-${stream}`)
                            .attr(
                                'y1',
                                dramWriteTileSentTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + coreOp.bar_height,
                            )
                            .attr(
                                'y2',
                                dramWriteTileSentTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + 2 * coreOp.bar_height,
                            );
                    }
                }

                if (coreOp.bufferStatus != undefined) {
                    for (let c = 0; c < coreOp.bufferStatus.streams.length; c++) {
                        const stream = coreOp.bufferStatus.streams[c];
                        this.opBars
                            .selectAll(`.buffer-status-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('y', bufferStatusTop(coreOp, c))
                            .attr('height', coreOp.bar_height);
                    }
                }
                if (coreOp.miscInfo != undefined) {
                    for (let c = 0; c < coreOp.miscInfo.streams.length; c++) {
                        const stream = coreOp.miscInfo.streams[c];
                        this.opBars
                            .selectAll(`.misc-info-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('y', miscInfoTop(coreOp, c))
                            .attr('height', coreOp.bar_height);
                    }
                }
            }
        }
        this.resetZoom();
        this.opBars
            .selectAll('.g-host-events')
            .attr(
                'transform',
                (event: HostEvent) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
        this.opBars
            .selectAll('.g-core-ops')
            .attr(
                'transform',
                (coreOp: CoreOp) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
            );
        this.updateHostBarSeparators();
        this.updateHostEventNames();
        this.updateNcriscBarSeparators();
        this.updateNcriscOpNames();
        this.zoomToDomain(domain);
    }

    updateFrequency(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        this.frequency = this.visProps.frequency;
        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            this.folderPathAllCoreOpsMap[folderPath].forEach((coreOp: CoreOp) =>
                coreOp.switchToFrequency(this.frequency),
            );
        }
        this.calculateFixedBounds();
        this.updateXScaleDomainAndApplyToBars();
    }

    updateUnit(newUnit: Unit): void {
        this.visProps.unit = newUnit;
        this.unit = this.visProps.unit;
        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            this.folderPathAllCoreOpsMap[folderPath].forEach((coreOp: CoreOp) => coreOp.switchToUnit(this.unit));
        }
        this.calculateFixedBounds();
        this.updateXScaleDomainAndApplyToBars();
    }

    // // TODO: find a better way
    // updateCoreOpFields(coreOp: CoreOp): CoreOp {
    //   if (this.ncriscVisProps.selectedFields.includes("Show All Fields")) {
    //     return coreOp;
    //   }
    //   const updatedCoreOp = new CoreOp(coreOp.opName, coreOp.folderPath, coreOp.id, coreOp.deviceId, coreOp.graphId, coreOp.loc, coreOp.epoch);
    //   updatedCoreOp.outOfMemory = coreOp.outOfMemory;
    //   updatedCoreOp.unit = coreOp.unit;
    //   for (const field of this.ncriscVisProps.selectedFields) {
    //     if (field === "Total Epoch") updatedCoreOp.epochTotal = coreOp.epochTotal;
    //     else if (field === "Epoch Prologue") updatedCoreOp.epochPrologue = coreOp.epochPrologue;
    //     else if (field === "Epoch Loop") updatedCoreOp.epochLoop = coreOp.epochLoop;
    //     else if (field === "Epoch Epilogue") updatedCoreOp.epochEpilogue = coreOp.epochEpilogue;
    //     else if (field === "Qslot Complete") updatedCoreOp.qSlotComplete = coreOp.qSlotComplete;
    //     else if (field === "Dram Read") updatedCoreOp.dramRead = coreOp.dramRead;
    //     else if (field === "Dram Write") updatedCoreOp.dramWrite = coreOp.dramWrite;
    //     else if (field === "Buffer Status") updatedCoreOp.bufferStatus = coreOp.bufferStatus;
    //     else if (field === "Misc Info") updatedCoreOp.miscInfo = coreOp.miscInfo;
    //   }
    //   return updatedCoreOp;
    // }

    updateXYOrder(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;

        // for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
        //   for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
        //     coreOp.xyOrder = this.visProps.xyOrder;
        //   }
        // }

        this.filterCoreOpsAndHostEvents();

        // let temp = {};
        // for (const key of Object.keys(this.coreOpsToPlot)) {
        //   let t = key.split("-");
        //   temp[t[1] + "-" + t[0]] = this.coreOpsToPlot[key];
        // }
        // this.coreOpsToPlot = temp;
        // this.cores = Object.keys(this.coreOpsToPlot);
        // this.cores.sort(sortCores);
        // console.log(this.cores);

        // let index = 0;
        // for (const core of this.cores) {
        //   for (const coreOp of this.coreOpsToPlot[core]) {
        //     this.hostEventCoreOpIndexMap[coreOp.id] = index;
        //   }
        //   index += 1;
        // }

        this.draw();
    }

    shouldPlotField(field: string): boolean {
        const result = this.selectedFields.includes(field);
        return result;
    }

    shouldPlotCore(core: string): boolean {
        if (this.visProps.xyOrder) {
            const t = core.split('-');
            return this.selectedCores.includes(`${t[1]}-${t[0]}`);
        }
        return this.selectedCores.includes(core);
    }

    handleSelectFolderPath(newFolderPath: string): void {
        const setEpochTotal = (coreOp: CoreOp, data: Object): void => {
            if (data.epoch != undefined && !isNaN(data.epoch.start) && !isNaN(data.epoch.end)) {
                coreOp.epochTotal = new Rect(data.epoch.start, data.epoch.end);
            }
        };

        const setEpochPrologue = (coreOp: CoreOp, data: Object): void => {
            if (
                data['epoch-prologue'] != undefined &&
                !isNaN(data['epoch-prologue'].start) &&
                !isNaN(data['epoch-prologue'].end)
            ) {
                coreOp.epochPrologue = new Rect(data['epoch-prologue'].start, data['epoch-prologue'].end);
            }
        };

        const setEpochLoop = (coreOp: CoreOp, data: Object): void => {
            if (data['epoch-loop'] != undefined && !isNaN(data['epoch-loop'].start) && !isNaN(data['epoch-loop'].end)) {
                coreOp.epochLoop = new Rect(data['epoch-loop'].start, data['epoch-loop'].end);
            }
        };

        const setEpochEpilogue = (coreOp: CoreOp, data: Object): void => {
            if (
                data['epoch-epilogue'] != undefined &&
                !isNaN(data['epoch-epilogue'].start) &&
                !isNaN(data['epoch-epilogue'].end)
            ) {
                coreOp.epochEpilogue = new Rect(data['epoch-epilogue'].start, data['epoch-epilogue'].end);
            }
        };

        const setQSlotCompletes = (coreOp: CoreOp, data: Object): void => {
            const qslotRegex = /^epoch-q-slot-complete-stream-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (qslotRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(qslotRegex)![1]);
                    if (!Array.isArray(data[field].end) || data[field].end.length == 0) {
                        console.error(`${coreOp.opName} "epoch-q-slot-complete-stream-${stream}" "end" possibly N/A.`);
                        continue;
                    }
                    if (coreOp.qSlotComplete == undefined) {
                        const lines = new Map<number, Line[]>();
                        lines.set(
                            stream,
                            data[field].end.map((cycle: number) => new Line(cycle)),
                        );
                        coreOp.qSlotComplete = {
                            streams: [stream],
                            lines,
                        };
                    } else if (coreOp.qSlotComplete != undefined) {
                        if (!coreOp.qSlotComplete.streams.includes(stream)) {
                            coreOp.qSlotComplete.streams.push(stream);
                        }
                        coreOp.qSlotComplete.lines.set(
                            stream,
                            data[field].end.map((cycle: number) => new Line(cycle)),
                        );
                    } else {
                        // TODO: Check what to do in this case
                        console.error(`Multiple "epoch-q-slot-complete-stream-${stream}" entries in ${coreOp.opName}`);
                    }
                }
            }
        };

        const setDramReads = (coreOp: CoreOp, data: Object): void => {
            const dramReadRegex = /^dram-read-stream-(\d+)-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (dramReadRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(dramReadRegex)![1]);
                    // TODO: check if tiles-flushed can be empty.
                    const dramReadStarts: number[] = Array.isArray(data[field]['chunk-read-issued'])
                        ? data[field]['chunk-read-issued']
                        : [];
                    const dramReadEnds: number[] = Array.isArray(data[field]['tiles-flushed'])
                        ? data[field]['tiles-flushed']
                        : [];
                    if (dramReadStarts.length == 0 && dramReadEnds.length == 0) {
                        continue;
                    }
                    if (coreOp.dramRead == undefined) {
                        const chunkReadIssued = new Map<number, Line[]>();
                        const tilesFlushed = new Map<number, Line[]>();
                        chunkReadIssued.set(
                            stream,
                            dramReadStarts.map((cycle: number) => new Line(cycle)),
                        );
                        tilesFlushed.set(
                            stream,
                            dramReadEnds.map((cycle: number) => new Line(cycle)),
                        );
                        coreOp.dramRead = {
                            streams: [stream],
                            chunkReadIssued,
                            tilesFlushed,
                        };
                    } else if (coreOp.dramRead != undefined) {
                        if (!coreOp.dramRead.streams.includes(stream)) {
                            coreOp.dramRead.streams.push(stream);
                            coreOp.dramRead.chunkReadIssued.set(
                                stream,
                                dramReadStarts.map((cycle: number) => new Line(cycle)),
                            );
                            coreOp.dramRead.tilesFlushed.set(
                                stream,
                                dramReadEnds.map((cycle: number) => new Line(cycle)),
                            );
                        } else {
                            console.error(`Multiple "dram-read-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        const setDramWrites = (coreOp: CoreOp, data: Object): void => {
            const dramWriteSentRegex = /^dram-write-sent-stream-(\d+)-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (dramWriteSentRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(dramWriteSentRegex)![1]);
                    // TODO: check if dram-write-tile-cleared can be empty.
                    const dramWriteSent: number[] = Array.isArray(data[field].end) ? data[field].end : [];
                    const dramWriteCleared: number[] =
                        data[`dram-write-tile-cleared-stream-${stream}`] != undefined &&
                        Array.isArray(data[`dram-write-tile-cleared-stream-${stream}`].end)
                            ? data[`dram-write-tile-cleared-stream-${stream}`].end
                            : [];
                    if (dramWriteSent.length == 0 && dramWriteCleared.length == 0) {
                        continue;
                    }

                    if (coreOp.dramWrite == undefined) {
                        const dramWriteSentStream = new Map<number, Line[]>();
                        const dramWriteTileCleared = new Map<number, Line[]>();
                        dramWriteSentStream.set(
                            stream,
                            dramWriteSent.map((cycle: number) => new Line(cycle)),
                        );
                        dramWriteTileCleared.set(
                            stream,
                            dramWriteCleared.map((cycle: number) => new Line(cycle)),
                        );
                        coreOp.dramWrite = {
                            streams: [stream],
                            dramWriteSentStream,
                            dramWriteTileCleared,
                        };
                    } else if (coreOp.dramWrite != undefined) {
                        if (!coreOp.dramWrite.streams.includes(stream)) {
                            coreOp.dramWrite.streams.push(stream);
                            coreOp.dramWrite.dramWriteSentStream.set(
                                stream,
                                dramWriteSent.map((cycle: number) => new Line(cycle)),
                            );
                            coreOp.dramWrite.dramWriteTileCleared.set(
                                stream,
                                dramWriteCleared.map((cycle: number) => new Line(cycle)),
                            );
                        } else {
                            console.error(`Multiple "dram-write-sent-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        const setBufferStatuses = (coreOp: CoreOp, data: Object): void => {
            const bufferStatusRegex = /^buffer-status-stream-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (bufferStatusRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(bufferStatusRegex)![1]);
                    const bufferDataStart = Array.isArray(data[field]['buf-available'])
                        ? data[field]['buf-available']
                        : [];
                    const bufferDataEnd = Array.isArray(data[field]['buf-full']) ? data[field]['buf-full'] : [];

                    if (bufferDataStart.length == 0 || bufferDataEnd.length == 0) {
                        continue;
                    }

                    if (coreOp.bufferStatus == undefined) {
                        const rects: Rect[] = [];
                        for (let i = 0; i < bufferDataStart.length && i < bufferDataEnd.length; i++) {
                            const rect = new Rect(bufferDataStart[i], bufferDataEnd[i]);
                            rects.push(rect);
                        }
                        const rectMap = new Map<number, Rect[]>();
                        rectMap.set(stream, rects);
                        coreOp.bufferStatus = {
                            streams: [stream],
                            rects: rectMap,
                        };
                    } else if (coreOp.bufferStatus != undefined) {
                        if (!coreOp.bufferStatus.streams.includes(stream)) {
                            coreOp.bufferStatus.streams.push(stream);
                            const rects: Rect[] = [];
                            for (let i = 0; i < bufferDataStart.length && i < bufferDataEnd.length; i++) {
                                const rect = new Rect(bufferDataStart[i], bufferDataEnd[i]);
                                rects.push(rect);
                            }
                            coreOp.bufferStatus.rects.set(stream, rects);
                        } else {
                            alert(`Multiple "buffer-status-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        const setMiscInfo = (coreOp: CoreOp, data: Object): void => {
            for (const field of Object.keys(data)) {
                if (field.startsWith('misc-info-stream-') && data[field] != undefined && data[field] != 'N/A') {
                    const stream = parseInt(field.split('-').splice(-1)[0]);
                    if (data[field].time != undefined && data[field].time != 'N/A' && data[field].time.length == 0) {
                        console.error(`${coreOp.opName} "misc-info-stream-${stream}" has empty "time" field.`);
                        continue;
                    }
                    if (coreOp.miscInfo === undefined) {
                        const rects = new Map<number, MiscInfoRect[]>();
                        const miscData =
                            data[field].data != undefined && data[field].data != 'N/A' ? data[field].data : [];
                        rects.set(stream, []);
                        for (let i = 0; i < data[field].time.length - 1; i++) {
                            rects
                                .get(stream)!
                                .push(new MiscInfoRect(data[field].time[i], data[field].time[i + 1], miscData[i]));
                        }
                        // Handle last element
                        rects
                            .get(stream)!
                            .push(new MiscInfoRect(lastElement(data[field].time), Infinity, lastElement(miscData)));
                        coreOp.miscInfo = {
                            streams: [stream],
                            rects,
                        };
                    } else if (coreOp.miscInfo !== undefined) {
                        if (!coreOp.miscInfo.streams.includes(stream)) {
                            coreOp.miscInfo.streams.push(stream);
                            coreOp.miscInfo.rects.set(stream, []);
                            const miscData =
                                data[field].data != undefined && data[field].data != 'N/A' ? data[field].data : [];
                            for (let i = 0; i < data[field].time.length - 1; i++) {
                                coreOp.miscInfo.rects
                                    .get(stream)!
                                    .push(new MiscInfoRect(data[field].time[i], data[field].time[i + 1], miscData[i]));
                            }
                            // Handle last element
                            coreOp.miscInfo.rects
                                .get(stream)!
                                .push(new MiscInfoRect(lastElement(data[field].time), Infinity, lastElement(miscData)));
                        } else {
                            alert(`Multiple "misc-info-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        if (this.data == null || !this.data.has(newFolderPath)) {
            console.error("Ncrisc dump: Shouldn't get here, all paths should be host directories");
            return;
        }

        const deviceId: number =
            this.data.get(newFolderPath)!['per-epoch-events'] &&
            this.data.get(newFolderPath)!['per-epoch-events']['device-id'];
        this.folderPathAllCoreOpsMap[newFolderPath] = [];
        for (const [opName, op_data] of Object.entries(this.data.get(newFolderPath)!)) {
            const [name, x, y] = parseOpIdentifier(opName);
            let graphId = getGraphId(newFolderPath);
            let epochId = '';
            if (graphId == '') {
                graphId = 'N/A';
                epochId = getEpochId(newFolderPath);
                if (epochId == '') {
                    console.error("Ncrisc dump: Couldn't find graph id or epoch id, shouldn't happen!");
                    continue;
                }
            }
            if (name == '' || !op_data.NCRISC) {
                continue;
            }

            const coreOp = new CoreOp(
                name,
                newFolderPath,
                op_data['core-op-id'],
                deviceId,
                graphId,
                { x, y },
                parseInt(epochId),
            );
            const ncriscData = op_data.NCRISC;
            setEpochTotal(coreOp, ncriscData);
            setEpochPrologue(coreOp, ncriscData);
            setEpochLoop(coreOp, ncriscData);
            setEpochEpilogue(coreOp, ncriscData);
            setQSlotCompletes(coreOp, ncriscData);
            setDramReads(coreOp, ncriscData);
            setDramWrites(coreOp, ncriscData);
            setBufferStatuses(coreOp, ncriscData);
            setMiscInfo(coreOp, ncriscData);
            if (coreOp.getNumRows() > 0) {
                coreOp.sortByStream();
                coreOp.checkOutOfMemory();
                this.folderPathAllCoreOpsMap[newFolderPath].push(coreOp);
            }
        }

        const matchingHostPath = Object.keys(this.folderPathHostToDeviceMap).find((hostPath: string) =>
            newFolderPath.startsWith(hostPath.split('/').slice(0, -1).join('/')),
        );
        if (matchingHostPath != undefined) {
            for (const coreOp of this.folderPathAllCoreOpsMap[newFolderPath]) {
                if (coreOp.deviceId == undefined) {
                    continue;
                }
                coreOp.populateHostInfo(this.folderPathHostToDeviceMap[matchingHostPath][coreOp.deviceId]);
                coreOp.populateUnitData();
                // default unit for these new ops is cycles, if the current user-selected unit is ns, switch these ops to use ns numbers.
                this.unit != Unit.CYCLES && coreOp.switchToUnit(this.unit);
                // default frequency for these new ops is derived, if the current user-selected frequency is AICLK, switch these ops to use AICLK.
                this.frequency != Frequency.DERIVED && coreOp.switchToFrequency(this.frequency);
            }
        }
    }

    processData(): void {
        this.folderPathAllCoreOpsMap = {};
        this.hostEventMap = {};
        this.folderPathHostToDeviceMap = {};
        // TODO: add error checking
        const setEpochTotal = (coreOp: CoreOp, data: Object): void => {
            if (data.epoch != undefined && !isNaN(data.epoch.start) && !isNaN(data.epoch.end)) {
                coreOp.epochTotal = new Rect(data.epoch.start, data.epoch.end);
            }
        };

        const setEpochPrologue = (coreOp: CoreOp, data: Object): void => {
            if (
                data['epoch-prologue'] != undefined &&
                !isNaN(data['epoch-prologue'].start) &&
                !isNaN(data['epoch-prologue'].end)
            ) {
                coreOp.epochPrologue = new Rect(data['epoch-prologue'].start, data['epoch-prologue'].end);
            }
        };

        const setEpochLoop = (coreOp: CoreOp, data: Object): void => {
            if (data['epoch-loop'] != undefined && !isNaN(data['epoch-loop'].start) && !isNaN(data['epoch-loop'].end)) {
                coreOp.epochLoop = new Rect(data['epoch-loop'].start, data['epoch-loop'].end);
            }
        };

        const setEpochEpilogue = (coreOp: CoreOp, data: Object): void => {
            if (
                data['epoch-epilogue'] != undefined &&
                !isNaN(data['epoch-epilogue'].start) &&
                !isNaN(data['epoch-epilogue'].end)
            ) {
                coreOp.epochEpilogue = new Rect(data['epoch-epilogue'].start, data['epoch-epilogue'].end);
            }
        };

        const setQSlotCompletes = (coreOp: CoreOp, data: Object): void => {
            const qslotRegex = /^epoch-q-slot-complete-stream-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (qslotRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(qslotRegex)![1]);
                    if (!Array.isArray(data[field].end) || data[field].end.length == 0) {
                        console.error(`${coreOp.opName} "epoch-q-slot-complete-stream-${stream}" "end" possibly N/A.`);
                        continue;
                    }
                    if (coreOp.qSlotComplete == undefined) {
                        const lines = new Map<number, Line[]>();
                        lines.set(
                            stream,
                            data[field].end.map((cycle: number) => new Line(cycle)),
                        );
                        coreOp.qSlotComplete = {
                            streams: [stream],
                            lines,
                        };
                    } else if (coreOp.qSlotComplete != undefined) {
                        if (!coreOp.qSlotComplete.streams.includes(stream)) {
                            coreOp.qSlotComplete.streams.push(stream);
                        }
                        coreOp.qSlotComplete.lines.set(
                            stream,
                            data[field].end.map((cycle: number) => new Line(cycle)),
                        );
                    } else {
                        // TODO: Check what to do in this case
                        console.error(`Multiple "epoch-q-slot-complete-stream-${stream}" entries in ${coreOp.opName}`);
                    }
                }
            }
        };

        const setDramReads = (coreOp: CoreOp, data: Object): void => {
            const dramReadRegex = /^dram-read-stream-(\d+)-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (dramReadRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(dramReadRegex)![1]);
                    // TODO: check if tiles-flushed can be empty.
                    const dramReadStarts: number[] = Array.isArray(data[field]['chunk-read-issued'])
                        ? data[field]['chunk-read-issued']
                        : [];
                    const dramReadEnds: number[] = Array.isArray(data[field]['tiles-flushed'])
                        ? data[field]['tiles-flushed']
                        : [];
                    if (dramReadStarts.length == 0 && dramReadEnds.length == 0) {
                        continue;
                    }
                    if (coreOp.dramRead == undefined) {
                        const chunkReadIssued = new Map<number, Line[]>();
                        const tilesFlushed = new Map<number, Line[]>();
                        chunkReadIssued.set(
                            stream,
                            dramReadStarts.map((cycle: number) => new Line(cycle)),
                        );
                        tilesFlushed.set(
                            stream,
                            dramReadEnds.map((cycle: number) => new Line(cycle)),
                        );
                        coreOp.dramRead = {
                            streams: [stream],
                            chunkReadIssued,
                            tilesFlushed,
                        };
                    } else if (coreOp.dramRead != undefined) {
                        if (!coreOp.dramRead.streams.includes(stream)) {
                            coreOp.dramRead.streams.push(stream);
                            coreOp.dramRead.chunkReadIssued.set(
                                stream,
                                dramReadStarts.map((cycle: number) => new Line(cycle)),
                            );
                            coreOp.dramRead.tilesFlushed.set(
                                stream,
                                dramReadEnds.map((cycle: number) => new Line(cycle)),
                            );
                        } else {
                            console.error(`Multiple "dram-read-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        const setDramWrites = (coreOp: CoreOp, data: Object): void => {
            const dramWriteSentRegex = /^dram-write-sent-stream-(\d+)-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (dramWriteSentRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(dramWriteSentRegex)![1]);
                    // TODO: check if dram-write-tile-cleared can be empty.
                    const dramWriteSent: number[] = Array.isArray(data[field].end) ? data[field].end : [];
                    const dramWriteCleared: number[] =
                        data[`dram-write-tile-cleared-stream-${stream}`] != undefined &&
                        Array.isArray(data[`dram-write-tile-cleared-stream-${stream}`].end)
                            ? data[`dram-write-tile-cleared-stream-${stream}`].end
                            : [];
                    if (dramWriteSent.length == 0 && dramWriteCleared.length == 0) {
                        continue;
                    }

                    if (coreOp.dramWrite == undefined) {
                        const dramWriteSentStream = new Map<number, Line[]>();
                        const dramWriteTileCleared = new Map<number, Line[]>();
                        dramWriteSentStream.set(
                            stream,
                            dramWriteSent.map((cycle: number) => new Line(cycle)),
                        );
                        dramWriteTileCleared.set(
                            stream,
                            dramWriteCleared.map((cycle: number) => new Line(cycle)),
                        );
                        coreOp.dramWrite = {
                            streams: [stream],
                            dramWriteSentStream,
                            dramWriteTileCleared,
                        };
                    } else if (coreOp.dramWrite != undefined) {
                        if (!coreOp.dramWrite.streams.includes(stream)) {
                            coreOp.dramWrite.streams.push(stream);
                            coreOp.dramWrite.dramWriteSentStream.set(
                                stream,
                                dramWriteSent.map((cycle: number) => new Line(cycle)),
                            );
                            coreOp.dramWrite.dramWriteTileCleared.set(
                                stream,
                                dramWriteCleared.map((cycle: number) => new Line(cycle)),
                            );
                        } else {
                            console.error(`Multiple "dram-write-sent-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        const setBufferStatuses = (coreOp: CoreOp, data: Object): void => {
            const bufferStatusRegex = /^buffer-status-stream-(\d+)$/;
            for (const field of Object.keys(data)) {
                if (bufferStatusRegex.test(field) && data[field] != undefined) {
                    const stream = parseInt(field.match(bufferStatusRegex)![1]);
                    const bufferDataStart = Array.isArray(data[field]['buf-available'])
                        ? data[field]['buf-available']
                        : [];
                    const bufferDataEnd = Array.isArray(data[field]['buf-full']) ? data[field]['buf-full'] : [];

                    if (bufferDataStart.length == 0 || bufferDataEnd.length == 0) {
                        continue;
                    }

                    if (coreOp.bufferStatus == undefined) {
                        const rects: Rect[] = [];
                        for (let i = 0; i < bufferDataStart.length && i < bufferDataEnd.length; i++) {
                            const rect = new Rect(bufferDataStart[i], bufferDataEnd[i]);
                            rects.push(rect);
                        }
                        const rectMap = new Map<number, Rect[]>();
                        rectMap.set(stream, rects);
                        coreOp.bufferStatus = {
                            streams: [stream],
                            rects: rectMap,
                        };
                    } else if (coreOp.bufferStatus != undefined) {
                        if (!coreOp.bufferStatus.streams.includes(stream)) {
                            coreOp.bufferStatus.streams.push(stream);
                            const rects: Rect[] = [];
                            for (let i = 0; i < bufferDataStart.length && i < bufferDataEnd.length; i++) {
                                const rect = new Rect(bufferDataStart[i], bufferDataEnd[i]);
                                rects.push(rect);
                            }
                            coreOp.bufferStatus.rects.set(stream, rects);
                        } else {
                            alert(`Multiple "buffer-status-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        const setMiscInfo = (coreOp: CoreOp, data: Object): void => {
            for (const field of Object.keys(data)) {
                if (field.startsWith('misc-info-stream-') && data[field] != undefined && data[field] != 'N/A') {
                    const stream = parseInt(field.split('-').splice(-1)[0]);
                    if (data[field].time != undefined && data[field].time != 'N/A' && data[field].time.length == 0) {
                        console.error(`${coreOp.opName} "misc-info-stream-${stream}" has empty "time" field.`);
                        continue;
                    }
                    if (coreOp.miscInfo === undefined) {
                        const rects = new Map<number, MiscInfoRect[]>();
                        const miscData =
                            data[field].data != undefined && data[field].data != 'N/A' ? data[field].data : [];
                        rects.set(stream, []);
                        for (let i = 0; i < data[field].time.length - 1; i++) {
                            rects
                                .get(stream)!
                                .push(new MiscInfoRect(data[field].time[i], data[field].time[i + 1], miscData[i]));
                        }
                        // Handle last element
                        rects
                            .get(stream)!
                            .push(new MiscInfoRect(lastElement(data[field].time), Infinity, lastElement(miscData)));
                        coreOp.miscInfo = {
                            streams: [stream],
                            rects,
                        };
                    } else if (coreOp.miscInfo !== undefined) {
                        if (!coreOp.miscInfo.streams.includes(stream)) {
                            coreOp.miscInfo.streams.push(stream);
                            coreOp.miscInfo.rects.set(stream, []);
                            const miscData =
                                data[field].data != undefined && data[field].data != 'N/A' ? data[field].data : [];
                            for (let i = 0; i < data[field].time.length - 1; i++) {
                                coreOp.miscInfo.rects
                                    .get(stream)!
                                    .push(new MiscInfoRect(data[field].time[i], data[field].time[i + 1], miscData[i]));
                            }
                            // Handle last element
                            coreOp.miscInfo.rects
                                .get(stream)!
                                .push(new MiscInfoRect(lastElement(data[field].time), Infinity, lastElement(miscData)));
                        } else {
                            alert(`Multiple "misc-info-stream-${stream}" entries in ${coreOp.opName}`);
                        }
                    }
                }
            }
        };

        for (const folderPath of this.allFolderPaths) {
            if (isHostDirectory(folderPath)) {
                if (this.hostData == null) {
                    console.error('Ncrisc: host directory selected but null host data');
                    continue;
                }
                processHostData(
                    this.hostData,
                    this.data,
                    folderPath,
                    this.hostEventMap,
                    this.folderPathHostToDeviceMap,
                );
                continue;
            }
            if (this.data == null) {
                console.error("Ncrisc dump: Shouldn't get here, all paths should be host directories");
                continue;
            }
            const deviceId: number =
                this.data.get(folderPath)!['per-epoch-events'] &&
                this.data.get(folderPath)!['per-epoch-events']['device-id'];
            for (const [opName, op_data] of Object.entries(this.data.get(folderPath)!)) {
                const [name, x, y] = parseOpIdentifier(opName);
                let graphId = getGraphId(folderPath);
                let epochId = '';
                if (graphId == '') {
                    graphId = 'N/A';
                    epochId = getEpochId(folderPath);
                    if (epochId == '') {
                        console.error("Couldn't find graph id or epoch id in ncrisc dump, shouldn't happen!");
                        continue;
                    }
                }
                if (name == '' || !op_data.NCRISC || Object.keys(op_data.NCRISC).length == 0) {
                    continue;
                }

                const coreOp = new CoreOp(
                    name,
                    folderPath,
                    op_data['core-op-id'],
                    deviceId,
                    graphId,
                    { x, y },
                    parseInt(epochId),
                );
                const ncriscData = op_data.NCRISC;

                setEpochTotal(coreOp, ncriscData);
                setEpochPrologue(coreOp, ncriscData);
                setEpochLoop(coreOp, ncriscData);
                setEpochEpilogue(coreOp, ncriscData);
                setQSlotCompletes(coreOp, ncriscData);
                setDramReads(coreOp, ncriscData);
                setDramWrites(coreOp, ncriscData);
                setBufferStatuses(coreOp, ncriscData);
                setMiscInfo(coreOp, ncriscData);
                if (coreOp.getNumRows() > 0) {
                    coreOp.sortByStream();
                    coreOp.checkOutOfMemory();
                    Array.isArray(this.folderPathAllCoreOpsMap[folderPath])
                        ? this.folderPathAllCoreOpsMap[folderPath].push(coreOp)
                        : (this.folderPathAllCoreOpsMap[folderPath] = [coreOp]);
                }
            }
        }

        const hostPaths = Object.keys(this.folderPathHostToDeviceMap);
        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            const matchingHostPath = hostPaths.find((hostPath: string) => {
                const hostParentPath = hostPath.split('/').slice(0, -1).join('/');
                return folderPath.startsWith(hostParentPath);
            });
            if (matchingHostPath != undefined) {
                for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                    if (coreOp.deviceId == undefined) {
                        continue;
                    }
                    coreOp.populateHostInfo(this.folderPathHostToDeviceMap[matchingHostPath][coreOp.deviceId]);
                    coreOp.populateUnitData();
                }
            }
        }
        this.sortHostEvents();
    }

    // sortOps(): void {
    //   for(const coreOps of Object.values(this.folderPathAllCoreOpsMap)){
    //     coreOps.sort((a: CoreOp, b: CoreOp) => { // sort by core coord
    //       if (a.loc.x !== b.loc.x)
    //         return a.loc.x - b.loc.x;

    //       else if (a.loc.y !== b.loc.y)
    //         return a.loc.y - b.loc.y;

    //       return 0;
    //     });
    //   }
    // }

    // Used when we want to fix the x axis to be from earliest epoch start to latest epoch end
    calculateFixedBounds(): void {
        this.startCycle = Infinity;
        this.endCycle = 0;

        this.startCycle = this.hostEventsToPlot.reduce((start: number, event: HostEvent): number => {
            const es = event.earliestStart;
            return Math.min(es, start);
        }, this.startCycle);

        this.endCycle = this.hostEventsToPlot.reduce((end: number, event: HostEvent): number => {
            const le = event.latestEnd;
            return Math.max(le, end);
        }, this.endCycle);

        if (Object.keys(this.folderPathAllCoreOpsMap).length === 0) {
            return;
        } // nothing to do

        for (const folderPath of this.folderPaths) {
            if (isHostDirectory(folderPath)) {
                continue;
            }
            for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                this.startCycle = Math.min(this.startCycle, coreOp.earliestStart());
                this.endCycle = Math.max(this.endCycle, coreOp.latestEnd());
            }
        }

        for (const folderPath of this.folderPaths) {
            if (isHostDirectory(folderPath)) {
                continue;
            }
            for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                coreOp.setLeftBound(this.startCycle);
                coreOp.updateMiscEndCycle(this.endCycle);
            }
        }
    }

    bar_text_line_y = (_, index: number): number =>
        NcriscD3Controller.MARGIN_SHIFT_DOWN + (index + 1) * this.BAR_REGION_HEIGHT - this.BAR_REGION_HEIGHT / 150;

    highlight(label: string): void {
        this.opNames.selectAll('text').attr('fill', (e: HostEvent | CoreOp[]) => {
            if (e instanceof HostEvent && e.name.includes(label)) {
                return '#00FFFF';
            }
            if (Array.isArray(e) && e[0].getCoreString().includes(label)) {
                return '#00FFFF';
            }
            if (e instanceof HostEvent) {
                return 'white';
            }
            return e.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white';
        });
    }

    createHostBars(regions: any): void {
        const { allProcesses } = this;
        const { hostEventColors } = this;
        regions.each(function (this: any, event: HostEvent) {
            d3.select(this)
                .selectAll(`.host-event-${event.id}`)
                .data(event.boxes)
                .enter()
                .append('rect')
                .attr('class', `host-event-${event.id}`)
                .attr('id', 'host-event')
                .attr('stroke', 'white')
                .attr('stroke-width', 2)
                .attr('fill', (box: Box) => hostEventColors(allProcesses.indexOf(box.process)))
                .style('cursor', 'pointer')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');

            d3.select(this)
                .append('line')
                .attr('class', `separator-host-${event.id}`)
                .attr('id', 'plot-separator')
                .attr('stroke', 'white')
                .attr('stroke-width', '1')
                .style('opacity', 0.3);
        });
    }

    // first time draw of host event bars
    drawHostBars(): void {
        const boxRegions = this.opBars
            .selectAll('.g-host-events')
            .data(this.hostEventsToPlot)
            .enter()
            .append('g')
            .attr('class', (event: HostEvent) => `g-host-events g-host-event-${event.id}`);

        this.createHostBars(boxRegions);
    }

    updateHostBars(eventRegions: any, eventsToUpdate: HostEvent[]): void {
        const { startCycle } = this;
        const { d3Ref } = this;
        const { opNames } = this;
        const { allProcesses } = this;
        const { hostEventColors } = this;
        function handleMouseOut(this: SVGGraphicsElement, _, box: Box) {
            d3.select(this).attr('fill', hostEventColors(allProcesses.indexOf(box.process)));
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
            opNames
                .selectAll('text')
                .filter((e: HostEvent | CoreOp[]) => e instanceof HostEvent && e.fullName == box.fullName)
                .attr('fill', 'white');
        }
        function handleMouseOver(this: SVGGraphicsElement, d: d3.MouseEvent, box: Box) {
            const text: string[] = [];
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black;">' + 'Host Event' + '</span>' + '</td>',
                '<br>',
                `<td id="name">` +
                    `<span style="color:black;">` +
                    `Event: ` +
                    `</span>` +
                    `</span>` +
                    `<span style="color:blue;">${box.eventName}</span>` +
                    `</td>`,
                '<br>',
                `<td id="process">` +
                    `<span style="color:black;">` +
                    `Process: ` +
                    `</span>` +
                    `</span>` +
                    `<span style="color:blue;">${box.process != undefined ? box.process : 'N/A'}</span>` +
                    `</td>`,
                '<br>',
                '<td id="unit">' +
                    '<span style="color:black;">' +
                    'Unit: ' +
                    '</span>' +
                    '</span>' +
                    '<span style="color:blue;">' +
                    'Nanoseconds' +
                    '</span>' +
                    '</td>',
                '<br>',
                // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                // '<br>',
                `<td id="start">` +
                    `<span style="color:black;">` +
                    `Start: ` +
                    `</span>` +
                    `<span style="color:blue;">${d3.format(',')(box.low - startCycle)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="end">` +
                    `<span style="color:black;">` +
                    `End: ` +
                    `</span>` +
                    `<span style="color:blue;">${d3.format(',')(box.high - startCycle)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="diff">` +
                    `<span style="color:black">` +
                    `Diff: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(box.high - box.low)}</span>` +
                    `</td>`,
                '</tr>',
            );

            d3.select(this).attr('fill', 'orange');
            const mouseLocation = { x: d.pageX, y: d.pageY };
            d3.select(d3Ref)
                .select('#tooltip')
                .attr('class', 'active-tooltip')
                .html(text.join(''))
                .style('background-color', 'white')
                .style('border', 'solid')
                .style('border-width', '2px')
                .style('border-radius', '5px')
                .style('padding', '5px')
                .style('opacity', 0.9);

            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
            const { width } = tooltip.getBoundingClientRect();
            const { height } = tooltip.getBoundingClientRect();
            const loc = locateTooltip(mouseLocation, width, height);
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);
            // highlight host event
            opNames
                .selectAll('text')
                .filter((e: HostEvent | CoreOp[]) => e instanceof HostEvent && e.fullName == box.fullName)
                .attr('fill', '#00FFFF');
        }

        for (const event of eventsToUpdate) {
            eventRegions
                .selectAll(`.host-event-${event.id}`)
                .attr('x', (box: Box) => this.currentXScale(box.low - this.startCycle))
                .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_TOP)
                .attr(
                    'width',
                    (box: Box) =>
                        this.currentXScale(box.high - this.startCycle) - this.currentXScale(box.low - this.startCycle),
                )
                .attr('height', event.barHeight)
                .on('mouseover', handleMouseOver)
                .on('mouseout', handleMouseOut);
        }
        this.updateHostBarSeparators();
        this.opBars
            .selectAll('.g-host-events')
            .attr(
                'transform',
                (event: HostEvent) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
    }

    updateHostBarSeparators(): void {
        const line_top = (): number => {
            const padding = this.BAR_REGION_HEIGHT / 150;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + this.BAR_REGION_HEIGHT - padding;
        };
        for (let i = 0; i < this.hostEventsToPlot.length; i++) {
            let folderPathChange = false;
            if (this.folderPaths.length > 1 && i < this.hostEventsToPlot.length - 1) {
                if (this.hostEventsToPlot[i + 1].folderPath != this.hostEventsToPlot[i].folderPath) {
                    folderPathChange = true;
                }
            }
            const line = this.opBars
                .selectAll(`.separator-host-${this.hostEventsToPlot[i].id}`)
                .attr('x1', 0)
                .attr('x2', this.FULL_W)
                .attr('y1', line_top)
                .attr('y2', line_top);
            if (folderPathChange) {
                line.attr('stroke', 'red').style('opacity', 0.4);
            }
        }
    }

    createHostEventNames(): void {
        this.opNames
            .selectAll('.g-host-event-name')
            .data(this.hostEventsToPlot)
            .enter()
            .append('g')
            .attr('class', 'g-host-event-name')
            .append('text')
            .attr('stroke', 'none')
            .text((event: HostEvent) => event.name);

        const folderPathShifts: number[] = [];
        if (this.folderPaths.length > 1) {
            for (let i = 0; i < this.hostEventsToPlot.length - 1; i++) {
                if (this.hostEventsToPlot[i + 1].folderPath != this.hostEventsToPlot[i].folderPath) {
                    folderPathShifts.push(i);
                }
            }
        }
        const textLineColor = (_, id): string => {
            return folderPathShifts.includes(id) ? 'red' : 'white';
        };

        const textLineOpacity = (_, id): number => {
            return folderPathShifts.includes(id) ? 0.2 : 0.1;
        };

        this.opNames
            .selectAll('.g-host-event-name')
            .append('line')
            .attr('class', 'text-separator-host')
            .attr('stroke', textLineColor)
            .attr('stroke-width', 1)
            .style('opacity', textLineOpacity);
    }

    updateHostEventNames(): void {
        const textPaddingLeft = 10;
        const bar_text_y = (index: number): number => {
            return (
                NcriscD3Controller.MARGIN_SHIFT_DOWN + index * this.BAR_REGION_HEIGHT + (1 / 2) * this.BAR_REGION_HEIGHT
            );
        };

        const hostEvents = this.hostEventsToPlot.map((event: HostEvent) => event.fullName);
        this.opNames
            .selectAll('.g-host-event-name')
            .selectAll('text')
            .attr('x', textPaddingLeft)
            .attr('y', function (this: SVGGraphicsElement, event: HostEvent): number {
                const textHeight = d3.select(this).node().getBBox().height;
                // console.log("TEXT HEIGHT: ", textHeight / 2.5)
                const y = bar_text_y(hostEvents.indexOf(event.fullName)) + textHeight / 4;
                return y;
            })
            .attr('fill', 'white')
            .attr('font-size', () => {
                if (this.visProps.barRegionHeight > 30) {
                    return '0.85em';
                }
                if (this.visProps.barRegionHeight > 15) {
                    return '0.7em';
                }
                return '0.5em';
            });

        this.opNames
            .selectAll('.text-separator-host')
            .attr('x1', 0)
            .attr('x2', NcriscD3Controller.MARGIN_LEFT)
            .attr('y1', this.bar_text_line_y)
            .attr('y2', this.bar_text_line_y);
    }

    createEpochTotalBars(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            d3.select(this)
                .selectAll(`.epoch-total-core-op-${coreOp.id}`)
                .data([coreOp])
                .enter()
                .append('rect')
                .attr('class', `epoch-total-core-op-${coreOp.id} ` + `ncrisc-dump-op-element`)
                .attr('id', 'epoch-total')
                .attr('stroke', (coreOp: CoreOp) => (coreOp.outOfMemory ? 'red' : 'white'))
                .attr('stroke-width', 0.5)
                .attr('fill', opColors.Total_Epoch)
                .style('cursor', 'pointer')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');
        });
    }

    createEpochLoopBars(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            d3.select(this)
                .selectAll(`.epoch-loop-core-op-${coreOp.id}`)
                .data([coreOp])
                .enter()
                .append('rect')
                .attr('class', `epoch-loop-core-op-${coreOp.id} ` + `ncrisc-dump-op-element`)
                .attr('id', 'epoch-loop')
                .attr('stroke', (coreOp: CoreOp) => (coreOp.outOfMemory ? 'red' : 'white'))
                .attr('stroke-width', 0.5)
                .attr('fill', opColors.Epoch_Loop)
                .style('cursor', 'pointer')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');
        });
    }

    createEpochPrologueBars(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            d3.select(this)
                .selectAll(`.epoch-prologue-core-op-${coreOp.id}`)
                .data([coreOp])
                .enter()
                .append('rect')
                .attr('class', `epoch-prologue-core-op-${coreOp.id} ` + `ncrisc-dump-op-element`)
                .attr('id', 'epoch-prologue')
                .attr('stroke', (coreOp: CoreOp) => (coreOp.outOfMemory ? 'red' : 'white'))
                .attr('stroke-width', 0.5)
                .attr('fill', opColors.Epoch_Prologue)
                .style('cursor', 'pointer')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');
        });
    }

    createEpochEpilogueBars(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            d3.select(this)
                .selectAll(`.epoch-epilogue-core-op-${coreOp.id}`)
                .data([coreOp])
                .enter()
                .append('rect')
                .attr('class', `epoch-epilogue-core-op-${coreOp.id} ` + `ncrisc-dump-op-element`)
                .attr('id', 'epoch-epilogue')
                .attr('stroke', (coreOp: CoreOp) => (coreOp.outOfMemory ? 'red' : 'white'))
                .attr('stroke-width', 0.5)
                .attr('fill', opColors.Epoch_Epilogue)
                .style('cursor', 'pointer')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');
        });
    }

    createQslotLines(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.qSlotComplete != undefined) {
                for (let c = 0; c < coreOp.qSlotComplete.streams.length; c++) {
                    const stream = coreOp.qSlotComplete.streams[c];
                    d3.select(this)
                        .selectAll(`.q-slot-complete-core-op-${coreOp.id}-stream-${stream}`)
                        .data(coreOp.qSlotComplete.lines.get(stream))
                        .enter()
                        .append('line')
                        .attr(
                            'class',
                            `q-slot-complete-core-op-${coreOp.id}-stream-${stream} ` + `ncrisc-dump-line-element`,
                        )
                        .attr('id', 'q-slot-complete')
                        .attr('stroke', opColors.Qslot_Complete)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            }
        });
    }

    createDramReadLines(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.dramRead != undefined) {
                for (let c = 0; c < coreOp.dramRead.streams.length; c++) {
                    const stream = coreOp.dramRead.streams[c];
                    d3.select(this)
                        .selectAll(`.dram-read-issued-core-op-${coreOp.id}-stream-${stream}`)
                        .data(coreOp.dramRead.chunkReadIssued.get(stream))
                        .enter()
                        .append('line')
                        .attr(
                            'class',
                            `dram-read-issued-core-op-${coreOp.id}-stream-${stream} ` + `ncrisc-dump-line-element`,
                        )
                        .attr('id', 'dram-read-issued')
                        .attr('stroke', opColors.Dram_Read_Chunk_Read_Issued)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            }
        });
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.dramRead != undefined) {
                for (let c = 0; c < coreOp.dramRead.streams.length; c++) {
                    const stream = coreOp.dramRead.streams[c];
                    d3.select(this)
                        .selectAll(`.dram-read-flushed-core-op-${coreOp.id}-stream-${stream}`)
                        .data(coreOp.dramRead.tilesFlushed.get(stream))
                        .enter()
                        .append('line')
                        .attr(
                            'class',
                            `dram-read-flushed-core-op-${coreOp.id}-stream-${stream} ` + `ncrisc-dump-line-element`,
                        )
                        .attr('id', 'dram-read-flushed')
                        .attr('stroke', opColors.Dram_Read_Tiles_Flushed)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            }
        });
    }

    createDramWriteLines(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.dramWrite != undefined) {
                for (let c = 0; c < coreOp.dramWrite.streams.length; c++) {
                    const stream = coreOp.dramWrite.streams[c];
                    d3.select(this)
                        .selectAll(`.dram-write-sent-core-op-${coreOp.id}-stream-${stream}`)
                        .data(coreOp.dramWrite.dramWriteSentStream.get(stream))
                        .enter()
                        .append('line')
                        .attr(
                            'class',
                            `dram-write-sent-core-op-${coreOp.id}-stream-${stream} ` + `ncrisc-dump-line-element`,
                        )
                        .attr('id', 'dram-write-sent')
                        .attr('stroke', opColors.Dram_Write_Tiles_Sent)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            }
        });
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.dramWrite !== undefined) {
                for (let c = 0; c < coreOp.dramWrite.streams.length; c++) {
                    const stream = coreOp.dramWrite.streams[c];
                    d3.select(this)
                        .selectAll(`.dram-write-cleared-core-op-${coreOp.id}-stream-${stream}`)
                        .data(coreOp.dramWrite.dramWriteTileCleared.get(stream))
                        .enter()
                        .append('line')
                        .attr(
                            'class',
                            `dram-write-cleared-core-op-${coreOp.id}-stream-${stream} ` + `ncrisc-dump-line-element`,
                        )
                        .attr('id', 'dram-write-cleared')
                        .attr('stroke', opColors.Dram_Write_Tiles_Cleared)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            }
        });
    }

    createBufferStatusBars(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.bufferStatus !== undefined) {
                for (let c = 0; c < coreOp.bufferStatus.streams.length; c++) {
                    const stream = coreOp.bufferStatus.streams[c];
                    d3.select(this)
                        .selectAll(`.buffer-status-core-op-${coreOp.id}-stream-${stream}`)
                        .data(coreOp.bufferStatus.rects.get(stream))
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `buffer-status-core-op-${coreOp.id}-stream-${stream} ` + `ncrisc-dump-rect-element`,
                        )
                        .attr('id', 'buffer-status')
                        .attr('fill', opColors.Buffer_Status)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            }
        });
    }

    createMiscInfoBars(regions: any): void {
        const { opColors } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.miscInfo !== undefined) {
                for (let c = 0; c < coreOp.miscInfo.streams.length; c++) {
                    const stream = coreOp.miscInfo.streams[c];
                    d3.select(this)
                        .selectAll(`.misc-info-core-op-${coreOp.id}-stream-${stream}`)
                        .data(coreOp.miscInfo.rects.get(stream))
                        .enter()
                        .append('rect')
                        .attr('class', `misc-info-core-op-${coreOp.id}-stream-${stream} ` + `ncrisc-dump-rect-element`)
                        .attr('id', 'misc-info')
                        .attr('fill', opColors.Misc_Info)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            }
        });
    }

    createNcriscBars(regions: any): void {
        this.shouldPlotField('Total Epoch') && this.createEpochTotalBars(regions);
        this.shouldPlotField('Epoch Loop') && this.createEpochLoopBars(regions);
        this.shouldPlotField('Epoch Prologue') && this.createEpochPrologueBars(regions);
        this.shouldPlotField('Epoch Epilogue') && this.createEpochEpilogueBars(regions);
        this.shouldPlotField('Qslot Complete') && this.createQslotLines(regions);
        this.shouldPlotField('Dram Read') && this.createDramReadLines(regions);
        this.shouldPlotField('Dram Write') && this.createDramWriteLines(regions);
        this.shouldPlotField('Buffer Status') && this.createBufferStatusBars(regions);
        this.shouldPlotField('Misc Info') && this.createMiscInfoBars(regions);

        const { opBars } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            const core = coreOp.getCoreString();
            if (opBars.selectAll(`.separator-core-${core}`).nodes().length > 0) {
                return;
            }
            d3.select(this)
                .append('line')
                .attr('class', `separator-core-${core}`)
                .attr('id', 'plot-separator')
                .attr('stroke', 'white')
                .attr('stroke-width', 1)
                .style('opacity', 0.3);
        });
    }

    drawNcriscBars(): void {
        for (const core of Object.keys(this.coreOpsToPlot)) {
            for (const coreOp of this.coreOpsToPlot[core]) {
                this.opBars
                    .selectAll(`.g-core-op-${coreOp.id}`)
                    .data([coreOp])
                    .enter()
                    .append('g')
                    .attr('class', `g-core-ops g-core-op-${coreOp.id}`);
            }
        }

        const regions = this.opBars.selectAll('.g-core-ops');
        this.createNcriscBars(regions);
        // this.opNames.selectAll("g").data(this.coreOpsToPlot)
        //   .enter()
        //   .append("g")
        //   .append("text")
        //   .attr("x", 0)
        //   .attr("font-size", "0.85em")
        //   .attr("stroke", "none")
        //   .attr("fill", "white")
        //   .text((op: CoreOp) => op.opName);
    }

    // functions for updating bars after first draw
    updateEpochTotalBars(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        const epoch_low = (op: CoreOp): number =>
            op.epochTotal != undefined ? this.currentXScale(op.epochTotal.low - this.startCycle) : 0;
        const epoch_high = (op: CoreOp): number =>
            op.epochTotal != undefined ? this.currentXScale(op.epochTotal.high - this.startCycle) : 0;
        const { d3Ref } = this;
        const { opNames } = this;
        const { opColors } = this;
        function handleMouseOver(this: SVGGraphicsElement, d, op: CoreOp) {
            const text: string[] = [];
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Total Epoch' + '</span>' + '</td>',
                '<br>',
                `<td id="op">` +
                    `<span style="color:black">` +
                    `Op: ` +
                    `</span>` +
                    `<span style="color:blue">${op.opName}</span>` +
                    `</td>`,
                '<br>',
                `<td id="graphId">` +
                    `<span style="color:black">` +
                    `Graph id: ` +
                    `</span>` +
                    `<span style="color:blue">${op.graphId}</span>` +
                    `</td>`,
                '<br>',
            );

            if (isNumber(op.deviceId)) {
                text.push(
                    `<td id="device-id">` +
                        `<span style="color:black">` +
                        `Device id:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.deviceId}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            if (isNumber(op.epoch)) {
                text.push(
                    `<td id="epoch">` +
                        `<span style="color:black">` +
                        `Epoch:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.epoch}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            text.push(
                `<td id="unit">` +
                    `<span style="color:black">` +
                    `Unit: ` +
                    `</span>` +
                    `<span style="color:blue">${op.unit}</span>` +
                    `</td>`,
                '<br>',
                `<td id="start">` +
                    `<span style="color:black">` +
                    `Start: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochTotal.low - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="end">` +
                    `<span style="color:black">` +
                    `End: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochTotal.high - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="diff">` +
                    `<span style="color:black">` +
                    `Diff: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochTotal.high - op.epochTotal.low)}</span>` +
                    `</td>`,
                '</tr>',
            );
            d3.select(this).attr('fill', 'orange');
            const mouseLocation = { x: d.pageX, y: d.pageY };
            d3.select(d3Ref)
                .select('#tooltip')
                .attr('class', 'active-tooltip')
                .html(text.join(''))
                .style('background-color', 'white')
                .style('border', 'solid')
                .style('border-width', '2px')
                .style('border-radius', '5px')
                .style('padding', '5px')
                .style('opacity', 0.9);

            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
            const { width } = tooltip.getBoundingClientRect();
            const { height } = tooltip.getBoundingClientRect();
            const loc = locateTooltip(mouseLocation, width, height);
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);

            // highlight op name
            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', '#00FFFF');
        }

        function handleMouseOut(this: SVGGraphicsElement, _, op: CoreOp) {
            d3.select(this).attr('fill', opColors.Total_Epoch);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);

            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', (e: CoreOp[]) => (e.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white'));
        }
        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                regions
                    .selectAll(`.epoch-total-core-op-${coreOp.id}`)
                    .attr('x', epoch_low)
                    .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_TOP)
                    .attr('width', (op: CoreOp) => epoch_high(op) - epoch_low(op))
                    .attr('height', (op: CoreOp) => op.bar_height)
                    .attr('fill', this.opColors.Total_Epoch)
                    .style('opacity', (op: CoreOp) => (op.epochTotal != undefined ? 1 : 0))
                    .on('mouseover', handleMouseOver)
                    .on('mouseout', handleMouseOut);
            }
        }
    }

    updateEpochLoopBars(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        const epoch_loop_low = (op: CoreOp): number =>
            op.epochLoop ? this.currentXScale(op.epochLoop.low - this.startCycle) : 0;
        const epoch_loop_high = (op: CoreOp): number =>
            op.epochLoop ? this.currentXScale(op.epochLoop.high - this.startCycle) : 0;
        const { d3Ref } = this;
        const { opNames } = this;
        const { opColors } = this;
        function handleMouseOver(this: SVGGraphicsElement, d, op: CoreOp) {
            const text: string[] = [];
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Epoch Loop' + '</span>' + '</td>',
                '<br>',
                `<td id="op">` +
                    `<span style="color:black">` +
                    `Op: ` +
                    `</span>` +
                    `<span style="color:blue">${op.opName}</span>` +
                    `</td>`,
                '<br>',
                `<td id="graphId">` +
                    `<span style="color:black">` +
                    `Graph id: ` +
                    `</span>` +
                    `<span style="color:blue">${op.graphId}</span>` +
                    `</td>`,
                '<br>',
            );

            if (isNumber(op.deviceId)) {
                text.push(
                    `<td id="device-id">` +
                        `<span style="color:black">` +
                        `Device id:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.deviceId}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            if (isNumber(op.epoch)) {
                text.push(
                    `<td id="epoch">` +
                        `<span style="color:black">` +
                        `Epoch:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.epoch}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            text.push(
                `<td id="unit">` +
                    `<span style="color:black">` +
                    `Unit: ` +
                    `</span>` +
                    `<span style="color:blue">${op.unit}</span>` +
                    `</td>`,
                '<br>',
                `<td id="start">` +
                    `<span style="color:black">` +
                    `Start: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochLoop.low - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="end">` +
                    `<span style="color:black">` +
                    `End: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochLoop.high - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="diff">` +
                    `<span style="color:black">` +
                    `Diff: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochLoop.high - op.epochLoop.low)}</span>` +
                    `</td>`,
                '</tr>',
            );
            d3.select(this).attr('fill', 'orange');
            const mouseLocation = { x: d.pageX, y: d.pageY };
            d3.select(d3Ref)
                .select('#tooltip')
                .attr('class', 'active-tooltip')
                .html(text.join(''))
                .style('background-color', 'white')
                .style('border', 'solid')
                .style('border-width', '2px')
                .style('border-radius', '5px')
                .style('padding', '5px')
                .style('opacity', 0.9);

            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
            const { width } = tooltip.getBoundingClientRect();
            const { height } = tooltip.getBoundingClientRect();
            const loc = locateTooltip(mouseLocation, width, height);
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);

            // highlight op name
            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', '#00FFFF');
        }

        function handleMouseOut(this: SVGGraphicsElement, _, op: CoreOp) {
            d3.select(this).attr('fill', opColors.Epoch_Loop);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', (e: CoreOp[]) => (e.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white'));
        }
        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                regions
                    .selectAll(`.epoch-loop-core-op-${coreOp.id}`)
                    .attr('x', epoch_loop_low)
                    .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_TOP)
                    .attr('width', (op: CoreOp) => epoch_loop_high(op) - epoch_loop_low(op))
                    .attr('height', (op: CoreOp) => op.bar_height)
                    .attr('fill', this.opColors.Epoch_Loop)
                    .style('opacity', (op: CoreOp) => (op.epochLoop != undefined ? 1 : 0))
                    .on('mouseover', handleMouseOver)
                    .on('mouseout', handleMouseOut);
            }
        }
    }

    updateEpochPrologueBars(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        // start and end x coordinates of epoch field
        const epoch_prologue_low = (op: CoreOp): number =>
            op.epochPrologue != undefined ? this.currentXScale(op.epochPrologue.low - this.startCycle) : 0;
        const epoch_prologue_high = (op: CoreOp): number =>
            op.epochPrologue != undefined ? this.currentXScale(op.epochPrologue.high - this.startCycle) : 0;
        const { d3Ref } = this;
        const { opNames } = this;
        const { opColors } = this;
        function handleMouseOver(this: SVGGraphicsElement, d, op: CoreOp) {
            const text: string[] = [];
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Epoch Prologue' + '</span>' + '</td>',
                '<br>',
                `<td id="op">` +
                    `<span style="color:black">` +
                    `Op: ` +
                    `</span>` +
                    `<span style="color:blue">${op.opName}</span>` +
                    `</td>`,
                '<br>',
                `<td id="graphId">` +
                    `<span style="color:black">` +
                    `Graph id: ` +
                    `</span>` +
                    `<span style="color:blue">${op.graphId}</span>` +
                    `</td>`,
                '<br>',
            );

            if (isNumber(op.deviceId)) {
                text.push(
                    `<td id="device-id">` +
                        `<span style="color:black">` +
                        `Device id:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.deviceId}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            if (isNumber(op.epoch)) {
                text.push(
                    `<td id="epoch">` +
                        `<span style="color:black">` +
                        `Epoch:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.epoch}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            text.push(
                `<td id="unit">` +
                    `<span style="color:black">` +
                    `Unit: ` +
                    `</span>` +
                    `<span style="color:blue">${op.unit}</span>` +
                    `</td>`,
                '<br>',
                `<td id="start">` +
                    `<span style="color:black">` +
                    `Start: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochPrologue.low - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="end">` +
                    `<span style="color:black">` +
                    `End: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochPrologue.high - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="diff">` +
                    `<span style="color:black">` +
                    `Diff: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochPrologue.high - op.epochPrologue.low)}</span>` +
                    `</td>`,
                '</tr>',
            );
            d3.select(this).attr('fill', 'orange');
            const mouseLocation = { x: d.pageX, y: d.pageY };
            d3.select(d3Ref)
                .select('#tooltip')
                .attr('class', 'active-tooltip')
                .html(text.join(''))
                .style('background-color', 'white')
                .style('border', 'solid')
                .style('border-width', '2px')
                .style('border-radius', '5px')
                .style('padding', '5px')
                .style('opacity', 0.9);

            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
            const { width } = tooltip.getBoundingClientRect();
            const { height } = tooltip.getBoundingClientRect();
            const loc = locateTooltip(mouseLocation, width, height);
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);

            // highlight op name
            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', '#00FFFF');
        }

        function handleMouseOut(this: SVGGraphicsElement, _, op: CoreOp) {
            d3.select(this).attr('fill', opColors.Epoch_Prologue);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);

            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', (e: CoreOp[]) => (e.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white'));
        }
        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                regions
                    .selectAll(`.epoch-prologue-core-op-${coreOp.id}`)
                    .attr('x', epoch_prologue_low)
                    .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_TOP)
                    .attr('width', (op: CoreOp) => epoch_prologue_high(op) - epoch_prologue_low(op))
                    .attr('height', (op: CoreOp) => op.bar_height)
                    .attr('fill', this.opColors.Epoch_Prologue)
                    .style('opacity', (op: CoreOp) => (op.epochPrologue != undefined ? 1 : 0))
                    .on('mouseover', handleMouseOver)
                    .on('mouseout', handleMouseOut);
            }
        }
    }

    updateEpochEpilogueBars(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        // start and end x coordinates of epoch field
        const epoch_epilogue_low = (op: CoreOp): number =>
            op.epochEpilogue != undefined ? this.currentXScale(op.epochEpilogue.low - this.startCycle) : 0;
        const epoch_epilogue_high = (op: CoreOp): number =>
            op.epochEpilogue != undefined ? this.currentXScale(op.epochEpilogue.high - this.startCycle) : 0;

        const { d3Ref } = this;
        const { opNames } = this;
        const { opColors } = this;
        function handleMouseOver(this: SVGGraphicsElement, d, op: CoreOp) {
            const text: string[] = [];
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Epoch Epilogue' + '</span>' + '</td>',
                '<br>',
                `<td id="op">` +
                    `<span style="color:black">` +
                    `Op: ` +
                    `</span>` +
                    `<span style="color:blue">${op.opName}</span>` +
                    `</td>`,
                '<br>',
                `<td id="graphId">` +
                    `<span style="color:black">` +
                    `Graph id: ` +
                    `</span>` +
                    `<span style="color:blue">${op.graphId}</span>` +
                    `</td>`,
                '<br>',
            );

            if (isNumber(op.deviceId)) {
                text.push(
                    `<td id="device-id">` +
                        `<span style="color:black">` +
                        `Device id:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.deviceId}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            if (isNumber(op.epoch)) {
                text.push(
                    `<td id="epoch">` +
                        `<span style="color:black">` +
                        `Epoch:  ` +
                        `</span>` +
                        `<span style="color:blue">${op.epoch}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            text.push(
                `<td id="unit">` +
                    `<span style="color:black">` +
                    `Unit: ` +
                    `</span>` +
                    `<span style="color:blue">${op.unit}</span>` +
                    `</td>`,
                '<br>',
                `<td id="start">` +
                    `<span style="color:black">` +
                    `Start: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochEpilogue.low - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="end">` +
                    `<span style="color:black">` +
                    `End: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochEpilogue.high - op.leftBound)}</span>` +
                    `</td>`,
                '<br>',
                `<td id="diff">` +
                    `<span style="color:black">` +
                    `Diff: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(op.epochEpilogue.high - op.epochEpilogue.low)}</span>` +
                    `</td>`,
                '</tr>',
            );
            d3.select(this).attr('fill', 'orange');
            const mouseLocation = { x: d.pageX, y: d.pageY };
            d3.select(d3Ref)
                .select('#tooltip')
                .attr('class', 'active-tooltip')
                .html(text.join(''))
                .style('background-color', 'white')
                .style('border', 'solid')
                .style('border-width', '2px')
                .style('border-radius', '5px')
                .style('padding', '5px')
                .style('opacity', 0.9);

            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
            const { width } = tooltip.getBoundingClientRect();
            const { height } = tooltip.getBoundingClientRect();
            const loc = locateTooltip(mouseLocation, width, height);
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);

            // highlight op name
            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', '#00FFFF');
        }

        function handleMouseOut(this: SVGGraphicsElement, _, op: CoreOp) {
            d3.select(this).attr('fill', opColors.Epoch_Epilogue);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
            opNames
                .selectAll('text')
                .filter(
                    (e: HostEvent | CoreOp[]) =>
                        !(e instanceof HostEvent) && e[0].getCoreString() == op.getCoreString(),
                )
                .attr('fill', (e: CoreOp[]) => (e.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white'));
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                regions
                    .selectAll(`.epoch-epilogue-core-op-${coreOp.id}`)
                    .attr('x', epoch_epilogue_low)
                    .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_TOP)
                    .attr('width', (op: CoreOp) => epoch_epilogue_high(op) - epoch_epilogue_low(op))
                    .attr('height', (op: CoreOp) => op.bar_height)
                    .attr('fill', this.opColors.Epoch_Epilogue)
                    .style('opacity', (op: CoreOp) => (op.epochEpilogue != undefined ? 1 : 0))
                    .on('mouseover', handleMouseOver)
                    .on('mouseout', handleMouseOut);
            }
        }
    }

    updateQslotLines(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        const { d3Ref } = this;

        const qSlotCompleteTop = (coreOp: CoreOp, qslotId: number): number => {
            let epoch_bar_height = 0;
            const prev_q_slot_bar_height = qslotId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            const prevBarHeights = epoch_bar_height + prev_q_slot_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        function handleMouseOut(this: SVGGraphicsElement) {
            d3.select(this).attr('stroke-width', 2);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                if (coreOp.qSlotComplete !== undefined) {
                    for (let c = 0; c < coreOp.qSlotComplete.streams.length; c++) {
                        const stream = coreOp.qSlotComplete.streams[c];
                        function handleMouseOver(this: SVGGraphicsElement, d, line: Line) {
                            const text: string[] = [];
                            const index = qslot.nodes().indexOf(this);
                            text.push(
                                '<tr>',
                                '<td id="field">' +
                                    '<span style="color:black">' +
                                    'Q-Slot Complete' +
                                    '</span>' +
                                    '</td>',
                                '<br>',
                                `<td id="index">` +
                                    `<span style="color:black">` +
                                    `ID: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="stream">` +
                                    `<span style="color:black">` +
                                    `Stream: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(stream)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="unit">` +
                                    `<span style="color:black">` +
                                    `Unit: ` +
                                    `</span>` +
                                    `<span style="color:blue">${line.unit}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="cycle">` +
                                    `<span style="color:black">` +
                                    `Timestamp: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(line.value - line.leftBound)}</span>` +
                                    `</td>`,
                            );
                            if (index < coreOp.qSlotComplete.lines.get(stream)!.length - 1) {
                                const nextLine = coreOp.qSlotComplete.lines.get(stream)![index + 1];
                                text.push(
                                    '<br>',
                                    `<td id="diff">` +
                                        `<span style="color:black">` +
                                        `Cycles until next: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(
                                            nextLine.value - line.value,
                                        )}</span>` +
                                        `</td>`,
                                );
                            }
                            text.push('</tr>');

                            d3.select(this).attr('stroke-width', 10);
                            const mouseLocation = { x: d.pageX, y: d.pageY };
                            d3.select(d3Ref)
                                .select('#tooltip')
                                .attr('class', 'active-tooltip')
                                .html(text.join(''))
                                .style('background-color', 'white')
                                .style('border', 'solid')
                                .style('border-width', '2px')
                                .style('border-radius', '5px')
                                .style('padding', '5px')
                                .style('opacity', 0.9);

                            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
                            const { width } = tooltip.getBoundingClientRect();
                            const { height } = tooltip.getBoundingClientRect();
                            const loc = locateTooltip(mouseLocation, width, height);
                            d3.select(d3Ref)
                                .select('.active-tooltip')
                                .style('left', `${loc.x}px`)
                                .style('top', `${loc.y}px`);
                        }
                        const qslot = regions
                            .selectAll(`.q-slot-complete-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('y1', qSlotCompleteTop(coreOp, c))
                            .attr('y2', qSlotCompleteTop(coreOp, c) + coreOp.bar_height)
                            .on('mouseover', handleMouseOver)
                            .on('mouseout', handleMouseOut);
                    }
                }
            }
        }
    }

    updateDramReadLines(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        const { d3Ref } = this;

        const dramReadIssuedTop = (coreOp: CoreOp, dramReadIssuedId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            // assuming each dram read stream has chunkReadIssued and tilesFlushed
            const prev_dram_read_bar_height =
                2 * (dramReadIssuedId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            const prevBarHeights = epoch_bar_height + qslot_bar_height + prev_dram_read_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        function handleMouseOut(this: SVGGraphicsElement) {
            d3.select(this).attr('stroke-width', 2);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                if (coreOp.dramRead != undefined) {
                    for (let c = 0; c < coreOp.dramRead.streams.length; c++) {
                        const stream = coreOp.dramRead.streams[c];
                        const flushed = coreOp.dramRead.tilesFlushed.get(stream);
                        function handleMouseOverIssued(this: SVGGraphicsElement, d, line: Line) {
                            const text: string[] = [];
                            const index = dramReadIssued.nodes().indexOf(this);
                            text.push(
                                '<tr>',
                                '<td id="field">' +
                                    '<span style="color:black">' +
                                    'Dram Read Chunk Issued' +
                                    '</span>' +
                                    '</td>',
                                '<br>',
                                `<td id="index">` +
                                    `<span style="color:black">` +
                                    `ID: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="stream">` +
                                    `<span style="color:black">` +
                                    `Stream: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(stream)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="unit">` +
                                    `<span style="color:black">` +
                                    `Unit: ` +
                                    `</span>` +
                                    `<span style="color:blue">${line.unit}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="start">` +
                                    `<span style="color:black">` +
                                    `Timestamp: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(line.value - line.leftBound)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="diff">` +
                                    `<span style="color:black">` +
                                    `Tiles flushed after: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(
                                        flushed![index] ? flushed![index].value - line.value : 'N/A',
                                    )}</span>` +
                                    `</td>`,
                                '</tr>',
                            );

                            d3.select(this).attr('stroke-width', 10);
                            const mouseLocation = { x: d.pageX, y: d.pageY };
                            d3.select(d3Ref)
                                .select('#tooltip')
                                .attr('class', 'active-tooltip')
                                .html(text.join(''))
                                .style('background-color', 'white')
                                .style('border', 'solid')
                                .style('border-width', '2px')
                                .style('border-radius', '5px')
                                .style('padding', '5px')
                                .style('opacity', 0.9);

                            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
                            const { width } = tooltip.getBoundingClientRect();
                            const { height } = tooltip.getBoundingClientRect();
                            const loc = locateTooltip(mouseLocation, width, height);
                            d3.select(d3Ref)
                                .select('.active-tooltip')
                                .style('left', `${loc.x}px`)
                                .style('top', `${loc.y}px`);
                        }

                        const dramReadIssued = regions
                            .selectAll(`.dram-read-issued-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('y1', dramReadIssuedTop(coreOp, c))
                            .attr('y2', dramReadIssuedTop(coreOp, c) + coreOp.bar_height)
                            .on('mouseover', handleMouseOverIssued)
                            .on('mouseout', handleMouseOut);

                        const chunkRead = coreOp.dramRead.chunkReadIssued.get(stream) || [];
                        function handleMouseOverFlushed(this: SVGGraphicsElement, d, line: Line) {
                            const text: string[] = [];
                            const index = dramReadFlushed.nodes().indexOf(this);
                            text.push(
                                '<tr>',
                                '<td id="field">' +
                                    '<span style="color:black">' +
                                    'Dram Read Tiles Flushed' +
                                    '</span>' +
                                    '</td>',
                                '<br>',
                                `<td id="index">` +
                                    `<span style="color:black">` +
                                    `ID: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="stream">` +
                                    `<span style="color:black">` +
                                    `Stream: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(stream)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="unit">` +
                                    `<span style="color:black">` +
                                    `Unit: ` +
                                    `</span>` +
                                    `<span style="color:blue">${line.unit}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="start">` +
                                    `<span style="color:black">` +
                                    `Timestamp ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(line.value - line.leftBound)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="diff">` +
                                    `<span style="color:black">` +
                                    `Diff with chunk read issued: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(
                                        chunkRead[index] ? line.value - chunkRead[index].value : 'N/A',
                                    )}</span>` +
                                    `</td>`,
                                '</tr>',
                            );

                            d3.select(this).attr('stroke-width', 10);
                            const mouseLocation = { x: d.pageX, y: d.pageY };
                            d3.select(d3Ref)
                                .select('#tooltip')
                                .attr('class', 'active-tooltip')
                                .html(text.join(''))
                                .style('background-color', 'white')
                                .style('border', 'solid')
                                .style('border-width', '2px')
                                .style('border-radius', '5px')
                                .style('padding', '5px')
                                .style('opacity', 0.9);

                            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
                            const { width } = tooltip.getBoundingClientRect();
                            const { height } = tooltip.getBoundingClientRect();
                            const loc = locateTooltip(mouseLocation, width, height);
                            d3.select(d3Ref)
                                .select('.active-tooltip')
                                .style('left', `${loc.x}px`)
                                .style('top', `${loc.y}px`);
                        }

                        const dramReadFlushed = regions
                            .selectAll(`.dram-read-flushed-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr(
                                'y1',
                                dramReadIssuedTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + coreOp.bar_height,
                            )
                            .attr(
                                'y2',
                                dramReadIssuedTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + 2 * coreOp.bar_height,
                            )
                            .on('mouseover', handleMouseOverFlushed)
                            .on('mouseout', handleMouseOut);
                    }
                }
            }
        }
    }

    updateDramWriteLines(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        const { d3Ref } = this;

        const dramWriteTileSentTop = (coreOp: CoreOp, dramWriteSentId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            let dram_read_bar_height = 0;
            // assuming exists tile sent and tile cleared for each dram write stream
            const prev_write_bar_height = 2 * (dramWriteSentId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            if (coreOp.dramRead !== undefined) {
                dram_read_bar_height =
                    2 * (coreOp.dramRead.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            const prevBarHeights = epoch_bar_height + qslot_bar_height + dram_read_bar_height + prev_write_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        function handleMouseOut(this: SVGGraphicsElement) {
            d3.select(this).attr('stroke-width', 2);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                if (coreOp.dramWrite !== undefined) {
                    for (let c = 0; c < coreOp.dramWrite.streams.length; c++) {
                        const stream = coreOp.dramWrite.streams[c];
                        function handleMouseOverSent(this: SVGGraphicsElement, d, line: Line) {
                            const text: string[] = [];
                            const index = sentTicks.nodes().indexOf(this);
                            // TODO: add diff with tile cleared (multiple clears per sent)
                            text.push(
                                '<tr>',
                                '<td id="field">' +
                                    '<span style="color:black">' +
                                    'Dram Write Sent Tile' +
                                    '</span>' +
                                    '</td>',
                                '<br>',
                                `<td id="index">` +
                                    `<span style="color:black">` +
                                    `ID: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="stream">` +
                                    `<span style="color:black">` +
                                    `Stream: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(stream)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="unit">` +
                                    `<span style="color:black">` +
                                    `Unit: ` +
                                    `</span>` +
                                    `<span style="color:blue">${line.unit}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="cycle">` +
                                    `<span style="color:black">` +
                                    `Timestamp: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(line.value - line.leftBound)}</span>` +
                                    `</td>`,
                            );

                            d3.select(this).attr('stroke-width', 10);
                            const mouseLocation = { x: d.pageX, y: d.pageY };
                            d3.select(d3Ref)
                                .select('#tooltip')
                                .attr('class', 'active-tooltip')
                                .html(text.join(''))
                                .style('background-color', 'white')
                                .style('border', 'solid')
                                .style('border-width', '2px')
                                .style('border-radius', '5px')
                                .style('padding', '5px')
                                .style('opacity', 0.9);

                            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
                            const { width } = tooltip.getBoundingClientRect();
                            const { height } = tooltip.getBoundingClientRect();
                            const loc = locateTooltip(mouseLocation, width, height);
                            d3.select(d3Ref)
                                .select('.active-tooltip')
                                .style('left', `${loc.x}px`)
                                .style('top', `${loc.y}px`);
                        }

                        const sentTicks = regions
                            .selectAll(`.dram-write-sent-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('y1', dramWriteTileSentTop(coreOp, c))
                            .attr('y2', dramWriteTileSentTop(coreOp, c) + coreOp.bar_height)
                            .on('mouseover', handleMouseOverSent)
                            .on('mouseout', handleMouseOut);

                        function handleMouseOverCleared(this: SVGGraphicsElement, d, line: Line) {
                            const text: string[] = [];
                            const index = tileCleared.nodes().indexOf(this);
                            text.push(
                                '<tr>',
                                '<td id="field">' +
                                    '<span style="color:black">' +
                                    'Dram Write Tile Cleared' +
                                    '</span>' +
                                    '</td>',
                                '<br>',
                                `<td id="index">` +
                                    `<span style="color:black">` +
                                    `ID: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="stream">` +
                                    `<span style="color:black">` +
                                    `Stream: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(stream)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="unit">` +
                                    `<span style="color:black">` +
                                    `Unit: ` +
                                    `</span>` +
                                    `<span style="color:blue">${line.unit}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="cycle">` +
                                    `<span style="color:black">` +
                                    `Timestamp: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(line.value - line.leftBound)}</span>` +
                                    `</td>`,
                                '</tr>',
                            );
                            d3.select(this).attr('stroke-width', 10);
                            const mouseLocation = { x: d.pageX, y: d.pageY };
                            d3.select(d3Ref)
                                .select('#tooltip')
                                .attr('class', 'active-tooltip')
                                .html(text.join(''))
                                .style('background-color', 'white')
                                .style('border', 'solid')
                                .style('border-width', '2px')
                                .style('border-radius', '5px')
                                .style('padding', '5px')
                                .style('opacity', 0.9);

                            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
                            const { width } = tooltip.getBoundingClientRect();
                            const { height } = tooltip.getBoundingClientRect();
                            const loc = locateTooltip(mouseLocation, width, height);
                            d3.select(d3Ref)
                                .select('.active-tooltip')
                                .style('left', `${loc.x}px`)
                                .style('top', `${loc.y}px`);
                        }
                        const tileCleared = regions
                            .selectAll(`.dram-write-cleared-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr(
                                'y1',
                                dramWriteTileSentTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + coreOp.bar_height,
                            )
                            .attr(
                                'y2',
                                dramWriteTileSentTop(coreOp, c) + NcriscD3Controller.MARGIN_TOP + 2 * coreOp.bar_height,
                            )
                            .on('mouseover', handleMouseOverCleared)
                            .on('mouseout', handleMouseOut);
                    }
                }
            }
        }
    }

    updateBufferStatusBars(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        const { d3Ref } = this;
        const { opColors } = this;

        const bufferStatusTop = (coreOp: CoreOp, bufferStatusId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            let dram_read_bar_height = 0;
            let dram_write_bar_height = 0;
            const prev_buffer_status_bar_height = bufferStatusId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            if (coreOp.dramRead !== undefined) {
                dram_read_bar_height =
                    2 * (coreOp.dramRead.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            if (coreOp.dramWrite !== undefined) {
                dram_write_bar_height =
                    2 * (coreOp.dramWrite.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            const prevBarHeights =
                epoch_bar_height +
                qslot_bar_height +
                dram_read_bar_height +
                dram_write_bar_height +
                prev_buffer_status_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        function handleMouseOut(this: SVGGraphicsElement) {
            d3.select(this).attr('fill', opColors.Buffer_Status);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                if (coreOp.bufferStatus != undefined) {
                    for (let c = 0; c < coreOp.bufferStatus.streams.length; c++) {
                        const stream = coreOp.bufferStatus.streams[c];
                        function handleMouseOver(this: SVGGraphicsElement, d, rect: Rect) {
                            const text: string[] = [];
                            const index = bufStatuses.nodes().indexOf(this);
                            text.push(
                                '<tr>',
                                '<td id="field">' +
                                    '<span style="color:black">' +
                                    'Buffer Status' +
                                    '</span>' +
                                    '</td>',
                                '<br>',
                                `<td id="index">` +
                                    `<span style="color:black">` +
                                    `ID: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="stream">` +
                                    `<span style="color:black">` +
                                    `Stream: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(stream)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="unit">` +
                                    `<span style="color:black">` +
                                    `Unit: ` +
                                    `</span>` +
                                    `<span style="color:blue">${rect.unit}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="start">` +
                                    `<span style="color:black">` +
                                    `Buffer available at: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(rect.low - rect.leftBound)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="end">` +
                                    `<span style="color:black">` +
                                    `Buffer full at: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(rect.high - rect.leftBound)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="diff">` +
                                    `<span style="color:black">` +
                                    `Diff: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(rect.high - rect.low)}</span>` +
                                    `</td>`,
                            );

                            if (index < coreOp.bufferStatus.rects.get(stream)!.length - 1) {
                                const nextAvailable = coreOp.bufferStatus.rects.get(stream)![index + 1].low;
                                text.push(
                                    '<br>',
                                    `<td id="fullDuration">` +
                                        `<span style="color:black">` +
                                        `Buffer full for: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(nextAvailable - rect.high)}</span>` +
                                        `</td>`,
                                );
                            }
                            text.push('</tr>');
                            d3.select(this).attr('fill', 'orange');
                            const mouseLocation = { x: d.pageX, y: d.pageY };
                            d3.select(d3Ref)
                                .select('#tooltip')
                                .attr('class', 'active-tooltip')
                                .html(text.join(''))
                                .style('background-color', 'white')
                                .style('border', 'solid')
                                .style('border-width', '2px')
                                .style('border-radius', '5px')
                                .style('padding', '5px')
                                .style('opacity', 0.9);

                            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
                            const { width } = tooltip.getBoundingClientRect();
                            const { height } = tooltip.getBoundingClientRect();
                            const loc = locateTooltip(mouseLocation, width, height);
                            d3.select(d3Ref)
                                .select('.active-tooltip')
                                .style('left', `${loc.x}px`)
                                .style('top', `${loc.y}px`);
                        }

                        const bufStatuses = regions
                            .selectAll(`.buffer-status-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                            .attr('y', bufferStatusTop(coreOp, c))
                            .attr(
                                'width',
                                (rect: Rect) =>
                                    this.currentXScale(rect.high - this.startCycle) -
                                    this.currentXScale(rect.low - this.startCycle),
                            )
                            .attr('height', coreOp.bar_height)
                            .attr('stroke', 'white')
                            .attr('stroke-width', 1)
                            .on('mouseover', handleMouseOver)
                            .on('mouseout', handleMouseOut);
                    }
                }
            }
        }
    }

    updateMiscInfoBars(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        const { d3Ref } = this;
        const { opColors } = this;

        const miscInfoTop = (coreOp: CoreOp, miscInfoId: number): number => {
            let epoch_bar_height = 0;
            let qslot_bar_height = 0;
            let dram_read_bar_height = 0;
            let dram_write_bar_height = 0;
            let buffer_status_bar_height = 0;
            const prev_misc_info_bar_height = miscInfoId * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            if (coreOp.hasEpochInfo()) {
                epoch_bar_height = NcriscD3Controller.MARGIN_TOP + coreOp.bar_height;
            }
            if (coreOp.qSlotComplete !== undefined) {
                qslot_bar_height =
                    coreOp.qSlotComplete.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            if (coreOp.dramRead !== undefined) {
                dram_read_bar_height =
                    2 * (coreOp.dramRead.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            if (coreOp.dramWrite !== undefined) {
                dram_write_bar_height =
                    2 * (coreOp.dramWrite.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height));
            }
            if (coreOp.bufferStatus !== undefined) {
                buffer_status_bar_height =
                    coreOp.bufferStatus.streams.length * (NcriscD3Controller.MARGIN_TOP + coreOp.bar_height);
            }
            const prevBarHeights =
                epoch_bar_height +
                qslot_bar_height +
                dram_read_bar_height +
                dram_write_bar_height +
                buffer_status_bar_height +
                prev_misc_info_bar_height;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + NcriscD3Controller.MARGIN_TOP;
        };

        function handleMouseOut(this: SVGGraphicsElement) {
            d3.select(this).attr('fill', opColors.Misc_Info);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const coreOp of coreOpsToUpdate[core]) {
                if (coreOp.miscInfo != undefined) {
                    // console.log(coreOp.opName)
                    // console.log(coreOp.miscInfo)
                    for (let c = 0; c < coreOp.miscInfo.streams.length; c++) {
                        const stream = coreOp.miscInfo.streams[c];
                        // console.log(stream);
                        function handleMouseOver(this: SVGGraphicsElement, d, rect: MiscInfoRect) {
                            const text: string[] = [];
                            const index = miscInfo.nodes().indexOf(this);
                            text.push(
                                '<tr>',
                                '<td id="field">' + '<span style="color:black">' + 'Misc Info' + '</span>' + '</td>',
                                '<br>',
                                `<td id="index">` +
                                    `<span style="color:black">` +
                                    `ID: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="stream">` +
                                    `<span style="color:black">` +
                                    `Stream: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(stream)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="unit">` +
                                    `<span style="color:black">` +
                                    `Unit: ` +
                                    `</span>` +
                                    `<span style="color:blue">${rect.unit}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="start">` +
                                    `<span style="color:black">` +
                                    `Start: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(rect.low - rect.leftBound)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="end">` +
                                    `<span style="color:black">` +
                                    `End: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(rect.high - rect.leftBound)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="diff">` +
                                    `<span style="color:black">` +
                                    `Diff: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(rect.high - rect.low)}</span>` +
                                    `</td>`,
                                '<br>',
                                `<td id="data">` +
                                    `<span style="color:black">` +
                                    `Data: ` +
                                    `</span>` +
                                    `<span style="color:blue">${d3.format(',')(rect.data)}</span>` +
                                    `</td>`,
                                '</tr>',
                            );
                            d3.select(this).attr('fill', 'orange');
                            const mouseLocation = { x: d.pageX, y: d.pageY };
                            d3.select(d3Ref)
                                .select('#tooltip')
                                .attr('class', 'active-tooltip')
                                .html(text.join(''))
                                .style('background-color', 'white')
                                .style('border', 'solid')
                                .style('border-width', '2px')
                                .style('border-radius', '5px')
                                .style('padding', '5px')
                                .style('opacity', 0.9);

                            const tooltip = d3.select(d3Ref).select('.active-tooltip').node();
                            const { width } = tooltip.getBoundingClientRect();
                            const { height } = tooltip.getBoundingClientRect();
                            const loc = locateTooltip(mouseLocation, width, height);
                            d3.select(d3Ref)
                                .select('.active-tooltip')
                                .style('left', `${loc.x}px`)
                                .style('top', `${loc.y}px`);
                        }
                        const miscInfo = regions
                            .selectAll(`.misc-info-core-op-${coreOp.id}-stream-${stream}`)
                            .attr('x', (rect: MiscInfoRect) => this.currentXScale(rect.low - this.startCycle))
                            .attr('y', miscInfoTop(coreOp, c))
                            .attr(
                                'width',
                                (rect: MiscInfoRect) => this.currentXScale(rect.high) - this.currentXScale(rect.low),
                            )
                            .attr('height', coreOp.bar_height)
                            .attr('stroke', 'black')
                            .attr('stroke-width', 1)
                            .on('mouseover', handleMouseOver)
                            .on('mouseout', handleMouseOut);
                    }
                }
            }
        }
    }

    updateNcriscBars(regions: any, coreOpsToUpdate: Record<string, CoreOp[]>): void {
        this.shouldPlotField('Total Epoch') && this.updateEpochTotalBars(regions, coreOpsToUpdate);
        this.shouldPlotField('Epoch Prologue') && this.updateEpochPrologueBars(regions, coreOpsToUpdate);
        this.shouldPlotField('Epoch Loop') && this.updateEpochLoopBars(regions, coreOpsToUpdate);
        this.shouldPlotField('Epoch Epilogue') && this.updateEpochEpilogueBars(regions, coreOpsToUpdate);
        this.shouldPlotField('Qslot Complete') && this.updateQslotLines(regions, coreOpsToUpdate);
        this.shouldPlotField('Dram Read') && this.updateDramReadLines(regions, coreOpsToUpdate);
        this.shouldPlotField('Dram Write') && this.updateDramWriteLines(regions, coreOpsToUpdate);
        this.shouldPlotField('Buffer Status') && this.updateBufferStatusBars(regions, coreOpsToUpdate);
        this.shouldPlotField('Misc Info') && this.updateMiscInfoBars(regions, coreOpsToUpdate);
        this.updateNcriscBarSeparators();
        this.opBars
            .selectAll('.g-core-ops')
            .attr(
                'transform',
                (coreOp: CoreOp) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
            );
    }

    updateNcriscBarSeparators(): void {
        const line_top = (): number => {
            const padding = this.BAR_REGION_HEIGHT / 150;
            return NcriscD3Controller.MARGIN_SHIFT_DOWN + this.BAR_REGION_HEIGHT - padding;
        };
        for (let coreId = 0; coreId < this.cores.length; coreId++) {
            const core = this.cores[coreId];
            this.plotSvg
                .selectAll(`.separator-core-${core}`)
                .attr('x1', 0)
                .attr('x2', this.FULL_W)
                .attr('y1', line_top())
                .attr('y2', line_top());
        }
    }

    createNcriscOpNames(): void {
        const coreOpsData: CoreOp[][] = [];
        for (const core of this.cores) {
            coreOpsData.push(this.coreOpsToPlot[core]);
        }

        this.opNames
            .selectAll('.g-op-name')
            .data(coreOpsData)
            .enter()
            .append('g')
            .attr('class', 'g-op-name')
            .append('text')
            .attr('x', 0)
            .attr('stroke', 'none')
            .attr('fill', (coreOps: CoreOp[]) =>
                coreOps.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white',
            )
            .text((coreOps: CoreOp[]) =>
                coreOps.some((coreOp: CoreOp) => coreOp.outOfMemory)
                    ? `${coreOps[0].getCoreString()}-out-of-memory`
                    : coreOps[0].getCoreString(),
            );

        this.opNames
            .selectAll('.g-op-name')
            .append('line')
            .attr('class', 'text-separator-ncrisc')
            .attr('stroke', 'white')
            .attr('stroke-width', 1)
            .attr('opacity', 0.1);
    }

    updateNcriscOpNames(): void {
        const textPaddingLeft = 10;
        const offsetY = this.hostEventsToPlot.length;
        const bar_text_y = (index: number): number => {
            return (
                NcriscD3Controller.MARGIN_SHIFT_DOWN +
                (index + offsetY) * this.BAR_REGION_HEIGHT +
                (1 / 2) * this.BAR_REGION_HEIGHT
            );
        };
        const coreRegex = /(\d+)-(\d+)/;
        const { cores } = this;
        // console.log(cores);
        this.opNames
            .selectAll('.g-op-name')
            .selectAll('text')
            .attr('x', textPaddingLeft)
            .attr('y', function (this: SVGGraphicsElement, coreOps: CoreOp[]) {
                const textHeight = d3.select(this).node().getBBox().height;
                // console.log(cores.indexOf(coreOps[0].getCoreString()));
                const y = bar_text_y(cores.indexOf(coreOps[0].getCoreString())) + textHeight / 3;
                return y;
            })
            .attr('font-size', () => {
                if (this.visProps.barRegionHeight > 30) {
                    return '0.85em';
                }
                if (this.visProps.barRegionHeight > 15) {
                    return '0.7em';
                }
                return '0.5em';
            });

        this.opNames
            .selectAll('.text-separator-ncrisc')
            .attr('x1', 0)
            .attr('x2', NcriscD3Controller.MARGIN_LEFT)
            .attr('y1', (_, index: number) => this.bar_text_line_y(_, index + offsetY))
            .attr('y2', (_, index: number) => this.bar_text_line_y(_, index + offsetY));
    }

    // functions for updating bars on zoom
    updateEpochTotalBarsOnAxisChange(): void {
        const epoch_low = (op: CoreOp): number =>
            op.epochTotal != undefined ? this.currentXScale(op.epochTotal.low - this.startCycle) : 0;
        const epoch_high = (op: CoreOp): number =>
            op.epochTotal != undefined ? this.currentXScale(op.epochTotal.high - this.startCycle) : 0;
        this.opBars
            .selectAll('#epoch-total')
            .attr('x', epoch_low)
            .attr('width', (coreOp: CoreOp) => epoch_high(coreOp) - epoch_low(coreOp));
    }

    updateEpochPrologueBarsOnAxisChange(): void {
        const epoch_low = (op: CoreOp): number =>
            op.epochPrologue != undefined ? this.currentXScale(op.epochPrologue.low - this.startCycle) : 0;
        const epoch_high = (op: CoreOp): number =>
            op.epochPrologue != undefined ? this.currentXScale(op.epochPrologue.high - this.startCycle) : 0;
        this.opBars
            .selectAll('#epoch-prologue')
            .attr('x', epoch_low)
            .attr('width', (coreOp: CoreOp) => epoch_high(coreOp) - epoch_low(coreOp));
    }

    updateEpochLoopBarsOnAxisChange(): void {
        const epoch_low = (op: CoreOp): number =>
            op.epochLoop != undefined ? this.currentXScale(op.epochLoop.low - this.startCycle) : 0;
        const epoch_high = (op: CoreOp): number =>
            op.epochLoop != undefined ? this.currentXScale(op.epochLoop.high - this.startCycle) : 0;
        this.opBars
            .selectAll('#epoch-loop')
            .attr('x', epoch_low)
            .attr('width', (coreOp: CoreOp) => epoch_high(coreOp) - epoch_low(coreOp));
    }

    updateEpochEpilogueBarsOnAxisChange(): void {
        const epoch_low = (op: CoreOp): number =>
            op.epochEpilogue != undefined ? this.currentXScale(op.epochEpilogue.low - this.startCycle) : 0;
        const epoch_high = (op: CoreOp): number =>
            op.epochEpilogue != undefined ? this.currentXScale(op.epochEpilogue.high - this.startCycle) : 0;
        this.opBars
            .selectAll('#epoch-epilogue')
            .attr('x', epoch_low)
            .attr('width', (coreOp: CoreOp) => epoch_high(coreOp) - epoch_low(coreOp));
    }

    updateNcriscBarsOnAxisChange(): void {
        if (this.shouldPlotField('Total Epoch')) {
            this.updateEpochTotalBarsOnAxisChange();
        }
        if (this.shouldPlotField('Epoch Prologue')) {
            this.updateEpochPrologueBarsOnAxisChange();
        }
        if (this.shouldPlotField('Epoch Loop')) {
            this.updateEpochLoopBarsOnAxisChange();
        }
        if (this.shouldPlotField('Epoch Epilogue')) {
            this.updateEpochEpilogueBarsOnAxisChange();
        }

        this.opBars
            .selectAll('.ncrisc-dump-rect-element')
            .attr('x', (rect: Rect | MiscInfoRect) => this.currentXScale(rect.low - this.startCycle))
            .attr(
                'width',
                (rect: Rect | MiscInfoRect) =>
                    this.currentXScale(rect.high - this.startCycle) - this.currentXScale(rect.low - this.startCycle),
            );

        this.opBars
            .selectAll('.ncrisc-dump-line-element')
            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle));

        this.updateIndicators();
    }

    redrawOnResize(): void {
        d3.select(this.d3Ref)
            .style('min-height', `${this.visProps.height + NcriscD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-height', `${this.visProps.height + NcriscD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-width', `${this.visProps.width + NcriscD3Controller.MARGIN_RIGHT}px`);

        this.svg
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM)
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM,
            ]);

        this.plotSvg
            .attr('height', this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM)
            .attr('width', this.FULL_W);

        this.xScale.range([0, this.FULL_W]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg
            .attr('transform', `translate(${0},${this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        this.xAxisg.lower();

        this.plotSvg.select('.backgroundRect').attr('height', this.FULL_H).attr('width', this.FULL_W);

        this.plotSvg.selectAll('#plot-separator').attr('x2', this.FULL_W);

        this.updateNcriscBarsOnAxisChange();
        this.updateHostBars(this.opBars, this.hostEventsToPlot);

        this.zoomScale = 1;

        this.zoom = d3
            .zoom()
            // .x(x)
            .scaleExtent([1, 17000])
            .on('zoom', (ev) => {
                this.zoomed(ev.transform);
            });

        this.zoom.translateExtent([
            [0, 0],
            [this.visProps.width, this.visProps.height],
        ]);
        this.plotSvg.call(this.zoom);

        // reset zoom transform, update bars to new x axis, and update region zoom x scale
        this.resetZoom();
    }

    updateXScaleDomainAndApplyToBars(): void {
        this.xScale.domain([0, this.endCycle - this.startCycle]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg.call(this.xAxis);

        this.xAxisg.lower();

        this.updateHostBars(this.opBars, this.hostEventsToPlot);
        this.updateNcriscBarsOnAxisChange();

        this.zoomScale = 1;

        this.zoom = d3
            .zoom()
            // .x(x)
            .scaleExtent([1, 17000])
            .on('zoom', (ev) => {
                this.zoomed(ev.transform);
            });

        this.zoom.translateExtent([
            [0, 0],
            [this.visProps.width, this.visProps.height],
        ]);
        this.plotSvg.call(this.zoom);

        // reset zoom transform, update bars to new x axis, and update region zoom x scale
        this.resetZoom();
        this.updateIndicators(true);
    }

    drawLegend(): void {
        let fieldNames: string[] = [];
        if (this.ncriscVisProps.selectedFields.includes('Show All Fields')) {
            fieldNames = this.allFields;
        } else {
            for (const field of this.ncriscVisProps.selectedFields) {
                if (field === 'Dram Read') {
                    fieldNames.push('Dram Read Chunk Read Issued', 'Dram Read Tiles Flushed');
                } else if (field === 'Dram Write') {
                    fieldNames.push('Dram Write Tiles Sent', 'Dram Write Tiles Cleared');
                } else {
                    fieldNames.push(field);
                }
            }
        }
        const rectTextSpacing = 4;
        const rectWidth = 15;
        const rectHeight = 15;

        // console.log(fieldNames)
        this.legend = this.svg
            .append('svg')
            .attr('class', 'legend-container')
            .attr('x', NcriscD3Controller.MARGIN_LEFT / 2)
            .attr('y', 3 * 22)
            .attr('width', 200)
            .attr('height', fieldNames.length * 22)
            .style('cursor', 'pointer');

        this.legend
            .selectAll('.legend')
            .data(fieldNames)
            .enter()
            .append('g')
            .attr('class', 'legend')
            .attr('transform', (d, i) => {
                const horz = 0;
                const height = rectHeight + rectTextSpacing;
                // var horz = -2 * legendRectSize;
                const vert = i * height;
                return `translate(${horz},${vert})`;
            });

        d3.selectAll('.legend')
            .append('rect')
            .attr('width', rectWidth)
            .attr('height', rectHeight)
            .style('fill', (field: string) => this.opColors[field.split(' ').join('_')])
            .style('stroke', (field: string) => this.opColors[field.split(' ').join('_')]);

        d3.selectAll('.legend')
            .append('text')
            .attr('x', rectWidth + rectTextSpacing)
            .attr('y', rectHeight - rectTextSpacing)
            .attr('stroke', 'none')
            .attr('fill', 'white')
            .attr('font-size', '0.7em')
            .text((field: string) => field);

        const dragHandler = d3.drag().on('drag', function (this: any, d) {
            d3.select(this).attr('x', d.x).attr('y', d.y);
        });

        dragHandler(this.svg.select('.legend-container'));
    }

    updateIndicators(switchUnit = false): void {
        const height = this.FULL_H;
        const { d3Ref } = this;
        const xScale = this.currentXScale;
        const { visProps } = this;
        const data = d3.selectAll('#cycleIndicator').data();
        // redraw diff lines on update
        if (switchUnit) {
            for (const indicator of data) {
                indicator.updateValueOnUnitChange(this.currentXScale);
            }
        }

        // console.log("Indicator data: ", data);
        const indicators = this.plotSvg
            .selectAll('#cycleIndicator')
            .attr('x1', (indicator: Indicator) => {
                return this.currentXScale(indicator.value);
            })
            .attr('x2', (indicator: Indicator) => this.currentXScale(indicator.value))
            .attr('y2', this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN);

        this.plotSvg
            .selectAll('#timePoint')
            .attr('x', (indicator: Indicator) => this.currentXScale(indicator.value))
            .text((indicator: Indicator) => d3.format(',')(indicator.value)); // Cycle displayed at the top

        // const bubble = d3.select("#tooltipTimeDiff");

        // if (!bubble.empty()) width = bubble.node().getBoundingClientRect().width;
        if (!indicators.empty() && indicators.nodes().length == 2) {
            const leftWidth = window.innerWidth - this.visProps.width + NcriscD3Controller.MARGIN_LEFT;
            const indicatorMid = (indicators.nodes()[0].getBBox().x + indicators.nodes()[1].getBBox().x) / 2;

            d3.select(this.d3Ref)
                .select('#tooltipTimeDiff')
                .html(
                    `<tr>` +
                        `<td>` +
                        `<span style="color:black">` +
                        `Diff: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(Math.abs(data[0].value - data[1].value))}</span>` +
                        `</td>` +
                        `</tr>`,
                )
                .style('left', () => `${leftWidth + indicatorMid}px`) // Diff bubble
                .style('opacity', () => {
                    const v = indicatorMid >= 0 && indicatorMid < this.FULL_W ? 0.9 : 0;
                    return v;
                });
        }

        this.plotSvg.on('click', function (this: any, d) {
            d.preventDefault();
            // alt + shift + click to delete all lines and numbers
            if (d.altKey && d.shiftKey) {
                d3.select(this).selectAll('#cycleIndicator').remove();
                d3.select(d3Ref).selectAll('#tooltipTimeDiff').remove();
                d3.select(this).selectAll('#timePoint').remove();
            }
            // shift + click to add line, max 2 lines allowed
            else if (d.shiftKey && d3.selectAll('#cycleIndicator').nodes().length < 2) {
                // relative coordinates
                const xy = d3.pointer(d);
                const cycle = Math.round(xScale.invert(xy[0]));
                const indicator = new Indicator(cycle, xy[0]);
                const index = d3.selectAll('#cycleIndicator').nodes().length;
                const newLine = d3
                    .select(this)
                    .append('line')
                    .data([indicator])
                    .attr('id', 'cycleIndicator')
                    .attr('x1', xy[0])
                    .attr('x2', xy[0])
                    .attr('y1', NcriscD3Controller.MARGIN_SHIFT_DOWN)
                    .attr('y2', height + NcriscD3Controller.MARGIN_SHIFT_DOWN)
                    .attr('stroke', '#ff0000')
                    .attr('stroke-width', 2)
                    .style('cursor', 'pointer')
                    .on('click', function (this: SVGGraphicsElement, d) {
                        // alt + click to delete the line and number
                        if (d.altKey) {
                            d.stopPropagation();
                            d3.select(d3Ref).selectAll('#tooltipTimeDiff').remove();
                            d3.select(`.timePoint-${index}`).remove();
                            d3.select(this).remove();
                        }
                    });
                const newTime = d3
                    .select(this)
                    .append('text')
                    .data([indicator])
                    .attr('class', `timePoint-${index}`)
                    .attr('id', 'timePoint')
                    .attr('x', xy[0])
                    .attr('y', 15)
                    .text((indicator: Indicator) => d3.format(',')(indicator.value))
                    .attr('fill', 'white')
                    .style('text-anchor', 'middle');

                newLine.raise();
                newTime.raise();

                // if we have two lines, show their difference
                if (d3.select(this).selectAll('#cycleIndicator').nodes().length === 2) {
                    const indicatorData = d3.select(this).selectAll('#cycleIndicator').data();
                    const indicators = d3.select(this).selectAll('#cycleIndicator').nodes();
                    const leftWidth = window.innerWidth - visProps.width + NcriscD3Controller.MARGIN_LEFT;
                    const mid = (indicators[0].getBBox().x + indicators[1].getBBox().x) / 2;
                    const num1 = indicatorData[0].value;
                    const num2 = indicatorData[1].value;

                    d3.select(d3Ref)
                        .append('div')
                        .attr('id', 'tooltipTimeDiff')
                        .attr('style', 'position: absolute;')
                        .style('background-color', 'white')
                        .style('border', 'solid')
                        .style('border-width', '2px')
                        .style('border-radius', '5px')
                        .style('padding', '5px')
                        .style('opacity', 0);

                    d3.select(d3Ref)
                        .select('#tooltipTimeDiff')
                        .html(
                            `<tr>` +
                                `<td>` +
                                `<span style="color:black">` +
                                `Diff: ` +
                                `</span>` +
                                `<span style="color:blue">${d3.format(',')(Math.abs(num1 - num2))}</span>` +
                                `</td>` +
                                `</tr>`,
                        )
                        .style('opacity', 0.9)
                        .style('left', `${leftWidth + mid}px`)
                        .style('top', `${d.pageY + 10}px`);
                } else {
                    d3.select(d3Ref).selectAll('#tooltipTimeDiff').remove();
                }
            }
        });
    }

    addIndicatorToXscale(cycleNum: number): void {
        const { d3Ref } = this;
        const { visProps } = this;
        const bubbleY = this.visProps.height / 1.8;
        const cycle = Math.round(cycleNum);
        const [leftBound, rightBound] = this.xScale.domain();
        if (cycle < leftBound || cycle > rightBound) {
            return;
        }
        const x = this.currentXScale(cycle);
        const indicator = new Indicator(cycle, x);
        const index = d3.selectAll('#cycleIndicator').nodes().length;
        const newLine = this.plotSvg
            .append('line')
            .data([indicator])
            .attr('id', 'cycleIndicator')
            .attr('x1', x)
            .attr('x2', x)
            .attr('y1', NcriscD3Controller.MARGIN_SHIFT_DOWN)
            .attr('y2', this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN)
            .attr('stroke', '#ff0000')
            .attr('stroke-width', 2)
            .style('cursor', 'pointer')
            .on('click', function (this: SVGGraphicsElement, d) {
                // alt + click to delete the line and number
                if (d.altKey) {
                    d.stopPropagation();
                    d3.select(d3Ref).selectAll('#tooltipTimeDiff').remove();
                    d3.select(`.timePoint-${index}`).remove();
                    d3.select(this).remove();
                }
            });
        const newTime = this.plotSvg
            .append('text')
            .data([indicator])
            .attr('class', `timePoint-${index}`)
            .attr('id', 'timePoint')
            .attr('x', x)
            .attr('y', 15)
            .text((indicator: Indicator) => d3.format(',')(indicator.value))
            .attr('fill', 'white')
            .style('text-anchor', 'middle');

        newLine.raise();
        newTime.raise();
        // if we have two lines, show their difference
        if (this.plotSvg.selectAll('#cycleIndicator').nodes().length === 2) {
            const indicators = this.plotSvg.selectAll('#cycleIndicator').nodes();
            const indicatorData = this.plotSvg.selectAll('#cycleIndicator').data();
            const leftWidth = window.innerWidth - visProps.width + NcriscD3Controller.MARGIN_LEFT;
            const mid = (indicators[0].getBBox().x + indicators[1].getBBox().x) / 2;
            const num1 = indicatorData[0].value;
            const num2 = indicatorData[1].value;

            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltipTimeDiff')
                .attr('style', 'position: absolute;')
                .style('background-color', 'white')
                .style('border', 'solid')
                .style('border-width', '2px')
                .style('border-radius', '5px')
                .style('padding', '5px')
                .style('opacity', 0);

            d3.select(d3Ref)
                .select('#tooltipTimeDiff')
                .html(
                    `<tr>` +
                        `<td>` +
                        `<span style="color:black">` +
                        `Diff: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(Math.abs(num1 - num2))}</span>` +
                        `</td>` +
                        `</tr>`,
                )
                .style('opacity', 0.9)
                .style('left', `${leftWidth + mid}px`)
                .style('top', `${bubbleY + 10}px`);
        }
    }

    updateZoomRightClickDrag(): void {
        const { currentXScale } = this;
        const { FULL_H } = this;
        const { FULL_W } = this;
        const { plotSvg } = this;

        const zoomToDomain = (newDomain: [number, number]): void => {
            this.zoomToDomain(newDomain);
        };

        const dragHandler = d3
            .drag()
            .on('drag', function (d) {
                // handle dragging

                if (plotSvg.selectAll('#zoom-line').nodes().length == 0 || d.x < 0 || d.x > FULL_W) {
                    return;
                }
                plotSvg.select('.zoom-line-1').attr('x1', d.x).attr('x2', d.x).style('opacity', 0.8);
            })
            .on('end', function () {
                const firstLineX = plotSvg.select('.zoom-line-0').attr('x1');
                const secondLineX = plotSvg.select('.zoom-line-1').attr('x1');
                const domainStart = currentXScale.invert(Math.min(firstLineX, secondLineX));
                const domainEnd = currentXScale.invert(Math.max(firstLineX, secondLineX));
                const newDomain: [number, number] = [domainStart, domainEnd];
                plotSvg.selectAll('#zoom-line').remove();
                zoomToDomain(newDomain);
            })
            .filter((event) => event.button == 2);

        // this.plotSvg
        //   .call(this.zoom)
        //   .on("mousedown.zoom", null);

        plotSvg
            .select('.backgroundRect')
            .on('contextmenu', function (d) {
                d.preventDefault();
                if (plotSvg.selectAll('#zoom-line').nodes().length >= 2) {
                    plotSvg.selectAll('#zoom-line').remove();
                }

                const mousePointer = d3.pointer(d);
                for (let i = 0; i < 2; i++) {
                    const line = plotSvg
                        .append('line')
                        .attr('class', `zoom-line-${i}`)
                        .attr('id', 'zoom-line')
                        .attr('y1', NcriscD3Controller.MARGIN_SHIFT_DOWN)
                        .attr('y2', FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN)
                        .attr('x1', mousePointer[0])
                        .attr('x2', mousePointer[0])
                        .attr('stroke', '#fc0352')
                        .attr('stroke-width', 2)
                        .style('opacity', 0.3);

                    line.raise();
                }
            })
            .call(dragHandler)
            .on('mouseup', function (d) {
                if (d.button !== 2) {
                    return;
                }
                plotSvg.selectAll('#zoom-line').remove();
            });
    }

    // note: region zoom and zoom should be updated
    updatePlotHeight(): void {
        // resize d3 ref (white box)
        d3.select(this.d3Ref)
            .style('min-height', `${this.visProps.height + NcriscD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-height', `${this.visProps.height + NcriscD3Controller.MARGIN_SHIFT_DOWN}px`);

        // resize svg
        this.svg
            .attr('height', this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM)
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM,
            ]);

        // resize plot svg
        this.plotSvg.attr(
            'height',
            this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM,
        );

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        // move x scale to the bottom of the plot
        this.xAxisg
            .attr('transform', `translate(${0},${this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        this.xAxisg.lower();

        this.plotSvg.select('.backgroundRect').attr('height', this.FULL_H);

        this.updateIndicators();
    }

    /** Main first-time draw function */
    draw(): void {
        d3.select(this.d3Ref).selectAll('*').remove();
        d3.select(this.d3Ref)
            .style('display', 'inline-block')
            .style('overflow-y', 'scroll')
            .style('border', 'solid')
            .style('border-width', '2px')
            .style('border-radius', '5px')
            .style('border-color', 'white')
            .style('min-height', `${this.visProps.height + NcriscD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-height', `${this.visProps.height + NcriscD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-width', `${this.visProps.width + NcriscD3Controller.MARGIN_RIGHT}px`);

        this.svg = d3
            .select(this.d3Ref)
            .append('svg')
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM)
            .attr('class', 'ncrisc-dump-d3')
            .attr('id', 'ncrisc-dump-d3')
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM,
            ])
            .style('shape-rendering', 'optimizeSpeed');

        this.plotSvg = this.svg
            .append('svg')
            .attr('x', NcriscD3Controller.MARGIN_LEFT)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN + NcriscD3Controller.MARGIN_BOTTOM)
            .attr('class', 'ncrisc-dump-d3-plot')
            .style('shape-rendering', 'optimizeSpeed');

        // Keep bars and lines from going out of the display box
        // this.svg.append("defs")
        //   .append("clipPath")
        //   .attr("id", "clipper")
        //   .append("rect")
        //   .attr("x", NcriscDumpD3.MARGIN_LEFT)
        //   .attr("y", 0)
        //   .attr("width", this.FULL_W)
        //   .attr("height", this.FULL_H + NcriscDumpD3.MARGIN_SHIFT_DOWN + NcriscDumpD3.MARGIN_BOTTOM);

        this.xScale = d3
            .scaleLinear()
            .domain([0, this.endCycle - this.startCycle])
            .range([0, this.FULL_W]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg = this.plotSvg
            .append('g')
            .attr('class', 'x_axis')
            .attr('transform', `translate(${0},${this.FULL_H + NcriscD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        // Darker background behind the bars
        this.plotSvg
            .append('rect')
            .attr('x', 0)
            .attr('y', NcriscD3Controller.MARGIN_SHIFT_DOWN)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H)
            .attr('stroke', 'white')
            .attr('stroke-width', '1px')
            .attr('fill', 'rgba(16, 22, 26, 0.3)')
            .attr('class', 'backgroundRect');

        this.opBars = this.plotSvg.append('g').attr('id', '#g-pd-opbars');
        this.opNames = this.svg.append('g').attr('id', 'g-pd-opnames');
        // .attr("style", "clip-path: url(#clipper)");

        d3.select(this.d3Ref)
            .append('div')
            .attr('id', 'tooltip')
            .attr('style', 'position: absolute;')
            .style('background-color', 'white')
            .style('border', 'solid')
            .style('border-width', '2px')
            .style('border-radius', '5px')
            .style('padding', '5px')
            .style('opacity', 0);

        this.drawHostBars();
        this.drawNcriscBars();

        this.zoomScale = 1;

        this.zoom = d3
            .zoom()
            // .x(x)
            .scaleExtent([1, 17000])
            .on('zoom', (ev) => {
                this.zoomed(ev.transform);
            });

        this.zoom.translateExtent([
            [0, 0],
            [this.visProps.width, this.visProps.height],
        ]);
        this.plotSvg.call(this.zoom);

        this.updateHostBars(this.opBars, this.hostEventsToPlot);
        this.updateNcriscBars(this.opBars, this.coreOpsToPlot);
        this.createHostEventNames();
        this.updateHostEventNames();
        this.createNcriscOpNames();
        this.updateNcriscOpNames();
        this.drawLegend();
        this.updateZoomRightClickDrag();
        this.updateIndicators();

        // console.log("Num bars in ncrisc: ", this.plotSvg.selectAll("*").nodes().length);
    }

    reDrawOnHostEventDeselect(eventsToRemoveFromPlot: HostEvent[]): void {
        for (const hostEvent of eventsToRemoveFromPlot) {
            this.opBars.selectAll(`.g-host-event-${hostEvent.id}`).remove();
        }
        // apply new x scale to bars
        this.updateXScaleDomainAndApplyToBars();
        // update y coordinate of host and device bars
        this.opBars
            .selectAll('.g-host-events')
            .attr(
                'transform',
                (event: HostEvent) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
        this.opBars
            .selectAll('.g-core-ops')
            .attr(
                'transform',
                (coreOp: CoreOp) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
            );
        this.updateHostBarSeparators();
        // update host event and op names
        this.opNames.selectAll('.g-host-event-name').remove();
        this.createHostEventNames();
        this.updateHostEventNames();
        this.opNames.selectAll('.g-op-name').remove();
        this.createNcriscOpNames();
        this.updateNcriscOpNames();
    }

    reDrawOnHostEventSelect(newEventsToPlot: HostEvent[]): void {
        const newHostEventRegions = this.opBars
            .selectAll('.placeholder-class')
            .data(newEventsToPlot)
            .enter()
            .append('g')
            .attr('class', (event: HostEvent) => `g-host-events g-host-event-${event.id}`);

        this.createHostBars(newHostEventRegions);
        this.updateHostBars(newHostEventRegions, newEventsToPlot);
        // apply new x scale to bars
        this.updateXScaleDomainAndApplyToBars();
        // update y coordinate of host and device bars
        this.opBars
            .selectAll('.g-host-events')
            .attr(
                'transform',
                (event: HostEvent) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
        this.opBars
            .selectAll('.g-core-ops')
            .attr(
                'transform',
                (coreOp: CoreOp) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
            );
        this.updateHostBarSeparators();
        // update host event and op names
        this.opNames.selectAll('.g-host-event-name').remove();
        this.createHostEventNames();
        this.updateHostEventNames();
        this.opNames.selectAll('.g-op-name').remove();
        this.createNcriscOpNames();
        this.updateNcriscOpNames();
    }

    // if the user deselected ops, remove the deslected ops from the plot
    reDrawOnOpDeselect(coreOpsToRemoveFromPlot: CoreOp[], updateXScale = true): void {
        for (const coreOp of coreOpsToRemoveFromPlot) {
            this.opBars.selectAll(`.g-core-op-${coreOp.id}`).remove();
        }

        // reset the domain of x and apply the new scale to the bars
        updateXScale && this.updateXScaleDomainAndApplyToBars();

        // move the bars to the correct rows
        this.opBars
            .selectAll('.g-core-ops')
            .attr(
                'transform',
                (coreOp: CoreOp) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
            );
        const regions = this.opBars.selectAll('.g-core-ops');
        regions.each(function (this: any, coreOp: CoreOp) {
            const core = coreOp.getCoreString();
            if (regions.selectAll(`.separator-core-${core}`).nodes().length > 0) {
                return;
            }
            d3.select(this)
                .append('line')
                .attr('class', `separator-core-${core}`)
                .attr('id', 'plot-separator')
                .attr('stroke', 'white')
                .attr('stroke-width', 1)
                .style('opacity', 0.3);
        });
        // re draw horizontal lines so that they are the correct color
        this.updateNcriscBarSeparators();
        // move op names to correct rows
        this.opNames.selectAll('.g-op-name').remove();
        this.createNcriscOpNames();
        this.updateNcriscOpNames();
    }

    reDrawOnOpSelect(newCoreOpsToPlot: Record<string, CoreOp[]>, updateXScale = true): void {
        let coreOps: CoreOp[] = [];
        for (const core of Object.keys(newCoreOpsToPlot)) {
            coreOps = coreOps.concat(newCoreOpsToPlot[core]);
        }
        const newOpRegions = this.opBars
            .selectAll('.placeholder-class')
            .data(coreOps)
            .enter()
            .append('g')
            .attr('class', (coreOp: CoreOp) => `g-core-ops g-core-op-${coreOp.id}`);

        // reset the domain of x and apply the new scale to the bars
        updateXScale && this.updateXScaleDomainAndApplyToBars();

        // draw the newly selected ops
        this.createNcriscBars(newOpRegions);
        // update y coordinate and mouse over listeners for the newly selected ops
        this.updateNcriscBars(newOpRegions, newCoreOpsToPlot);

        // move the bars to the correct rows
        this.opBars
            .selectAll('.g-core-ops')
            .attr(
                'transform',
                (coreOp: CoreOp) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
            );
        // move op names to correct rows
        this.opNames.selectAll('.g-op-name').remove();
        this.createNcriscOpNames();
        this.updateNcriscOpNames();
    }

    getNumBars(): number {
        return this.svg.selectAll('*').nodes().length;
        // return this.plotSvg.selectAll(".ncrisc-dump-op-element,.ncrisc-dump-line-element,.ncrisc-dump-rect-element").nodes().length;
    }

    // Delete everything
    close(): void {
        console.log('Closing ncrisc dump d3');
        d3.select(this.d3Ref).selectAll('*').remove();
        d3.select(this.d3Ref).style('display', 'none');
    }

    zoomToDomain(domain: [number, number]): void {
        if (
            !Array.isArray(domain) ||
            domain.length != 2 ||
            !isNumber(domain[0]) ||
            !isNumber(domain[1]) ||
            domain[1] <= domain[0]
        ) {
            return;
        }
        // zoom bars to original user domain
        const [oldStart, oldEnd] = this.currentXScale.domain();
        const [newStart, newEnd] = domain;
        // check if the new domain we want to zoom to is within our new x scale
        if (newStart >= oldStart && newEnd <= oldEnd) {
            // length of domains
            const oldRange = Math.abs(oldEnd - oldStart);
            const newRange = Math.abs(newEnd - newStart);
            if (newRange <= 0) {
                return;
            }
            // zoom in the x scale domain
            const scaleIncrease = oldRange / newRange;
            this.plotSvg.call(this.zoom.scaleBy, scaleIncrease);
            // shift the xscale, number of pixels is determined by zoomed in xscale.
            // translateBy multiplies the shift by the transform scale (k), divide
            // shift prior to passing it in so we don't shift by k times extra.
            const xShift = -this.currentXScale(newStart);
            this.plotSvg.call(this.zoom.translateBy, xShift / this.zoomScale, 0);
        }
    }

    zoomed(transform: any): void {
        this.zoomScale = transform.k;
        transform.y = 0;
        // clamp x tranform to the width of the plot
        transform.x = Math.max(transform.x, (1 - transform.k) * this.FULL_W);
        const new_x_scale = transform.rescaleX(this.xScale);
        this.xAxisg.call(this.xAxis.scale(new_x_scale));

        this.currentXScale = new_x_scale;
        this.domain = this.currentXScale.domain();

        this.opBars.selectAll('.g-core-ops').attr('transform', (coreOp: CoreOp) => {
            return transform
                .toString()
                .replace(
                    /translate\((.*?)\)/,
                    `translate(${transform.x}, ${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
                )
                .replace(/scale\((.*?)\)/, 'scale($1, 1)');
        });

        this.opBars.selectAll('.g-host-events').attr('transform', (event: HostEvent) => {
            return transform
                .toString()
                .replace(
                    /translate\((.*?)\)/,
                    `translate(${transform.x}, ${
                        this.hostEventCoreOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT
                    })`,
                )
                .replace(/scale\((.*?)\)/, 'scale($1, 1)');
        });

        this.updateZoomRightClickDrag();
        this.updateIndicators();
    }

    // Zoom out
    resetZoom(): void {
        console.log('reset zoom');
        this.zoomed(d3.zoomIdentity);
        this.plotSvg.call(this.zoom.transform, d3.zoomIdentity);
    }

    getNumPlottedElements(): number {
        return (
            this.hostEventsToPlot.length +
            Object.entries(this.coreOpsToPlot)
                .map(([_, ops]) => ops.length)
                .reduce((a, b) => a + b, 0)
        );
    }
}
