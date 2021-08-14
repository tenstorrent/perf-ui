// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

/**
 * D3 portion (visualization) of the perf dump
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
    PerfDumpFolderMap,
    PerfDumpVisProps,
    Rect,
    Unit,
    getEpochId,
    getGraphId,
    isHostDirectory,
    isNumber,
    lastElement,
    locateTooltip,
    processHostData,
    sortCores,
    twoDecimals,
} from '../perf_utils';
// import { ZoomEvent } from "d3-zoom";

interface Bounds {
    low: number | undefined;
    high: number | undefined;
}

interface CoreOpData {
    bounds: Bounds;
    unpackerFirstBlockDataAvailable: number | undefined;
    packFinishLastOuterLoop: number | undefined;
    modelCycles: number | undefined;
    modelCyclesProp: number | undefined;
}

// Op on one particular core
class CoreOp {
    loc: Coord;

    opName: string;

    id: string;

    deviceId: number;

    graphId: string;

    epoch: number | null;

    input: string; // in form input-x

    folderPath: string;

    visProps: PerfDumpVisProps;

    bounds: Bounds; // calculated and cached bounds, scaled to start/end cycles for the full test

    dramReadIssued: Line[]; // Don't split by input because we plot all inputs together

    dramReadFlushed: Line[];

    dramWriteSent: Line[]; // Don't split by input because we plot all inputs together

    dramWriteCleared: Line[];

    unpackerFirstBlockDataAvailable: number | undefined;

    packFinishLastOuterLoop: number | undefined;

    modelCycles: number | undefined;

    modelCyclesProp: number | undefined;

    showWaitForTile: boolean;

    waitForIncomingTiles: Map<string, Rect[]>;

    waitForFreeTiles: Map<string, Rect[]>;

    triscStallOnDramUnpacker: Map<string, Rect[]>;

    triscStallOnDramPacker: Map<string, Rect[]>;

    mathUtilization: number;

    unpackBw: { [name: string]: number };

    packBw: number;

    leftBound: number;

    deviceStartCycle: number;

    deviceStartNs: number;

    unit: string;

    frequency: string;

    unitConversionMap: Map<string, (oldValue: number) => number>;

    unitData: Map<string, CoreOpData>;

    barHeightRatio: number;

    barHeight: number;

    outOfMemory: boolean;

    xyOrder: boolean;

    constructor(
        name: string,
        folderPath: string,
        deviceId: number,
        graphId: string,
        loc: Coord,
        input: string,
        id: string,
        visProps: PerfDumpVisProps,
        epoch: number | null,
    ) {
        this.loc = loc;
        this.opName = name;
        this.folderPath = folderPath;
        this.deviceId = deviceId;
        this.graphId = graphId;
        this.epoch = epoch;
        this.input = input;
        this.id = `${id}-${this.input}`;
        this.visProps = visProps;
        this.dramReadIssued = [];
        this.dramReadFlushed = [];
        this.dramWriteSent = [];
        this.dramWriteCleared = [];
        this.showWaitForTile = true;
        this.waitForIncomingTiles = new Map<string, Rect[]>();
        this.waitForFreeTiles = new Map<string, Rect[]>();
        this.triscStallOnDramUnpacker = new Map<string, Rect[]>();
        this.triscStallOnDramPacker = new Map<string, Rect[]>();
        this.unpackBw = {};
        this.outOfMemory = false;
        this.unit = Unit.CYCLES;
        this.frequency = Frequency.DERIVED;
        this.unitConversionMap = new Map<string, (oldValue: number) => number>();
        this.unitData = new Map<string, CoreOpData>();
    }

    sortNcriscEvents(): void {
        const ascending = (a: Line, b: Line): number => {
            return a.value - b.value;
        };

        this.dramReadIssued.length > 0 && this.dramReadIssued.sort(ascending);
        this.dramReadFlushed.length > 0 && this.dramReadFlushed.sort(ascending);
        this.dramWriteSent.length > 0 && this.dramWriteSent.sort(ascending);
        this.dramWriteCleared.length > 0 && this.dramWriteCleared.sort(ascending);
    }

    getCoreString(): string {
        if (this.xyOrder) {
            return `${this.loc.y}-${this.loc.x}`;
        }
        return `${this.loc.x}-${this.loc.y}`;
    }

    getNumRows(): number {
        let rows = 0;
        if (this.unpackerFirstBlockDataAvailable != undefined || this.packFinishLastOuterLoop != undefined) {
            rows += 1;
        }
        if (
            this.visProps.showModelNumbers &&
            (this.unpackerFirstBlockDataAvailable != undefined || this.packFinishLastOuterLoop != undefined)
        ) {
            rows += 1;
        }
        if (this.visProps.showAllDramReads && this.dramReadIssued.length > 0) {
            rows += 1;
        }
        if (this.visProps.showAllDramWrites && this.dramWriteSent.length > 0) {
            rows += 1;
        }
        if (this.showWaitForTile) {
            rows += this.waitForIncomingTiles.size;
        }
        if (this.showWaitForTile) {
            rows += this.waitForFreeTiles.size;
        }
        rows += this.triscStallOnDramUnpacker.size;
        rows += this.triscStallOnDramPacker.size;
        return rows;
    }

    getBarHeightRatio(): number {
        if (this.getNumRows() === 0) {
            return 0;
        }
        this.barHeightRatio = 2 / (3 * this.getNumRows());

        return this.barHeightRatio;
    }

    earliestRead(): number {
        let earliestRead = Infinity;
        if (this.dramReadIssued.length > 0) {
            earliestRead = this.dramReadIssued[0].value;
        }
        if (this.dramReadFlushed.length > 0) {
            earliestRead = Math.min(earliestRead, this.dramReadFlushed[0].value);
        }
        return earliestRead;
    }

    latestRead(): number {
        let latestRead = 0;
        if (this.dramReadIssued.length > 0) {
            latestRead = lastElement(this.dramReadIssued).value;
        }
        if (this.dramReadFlushed.length > 0) {
            latestRead = Math.max(latestRead, lastElement(this.dramReadFlushed).value);
        }
        return latestRead;
    }

    earliestWrite(): number {
        let earliestWrite = Infinity;
        if (this.dramWriteSent.length > 0) {
            earliestWrite = this.dramWriteSent[0].value;
        }
        if (this.dramWriteCleared.length > 0) {
            earliestWrite = Math.min(earliestWrite, this.dramWriteCleared[0].value);
        }
        return earliestWrite;
    }

    latestWrite(): number {
        let latestWrite = 0;
        if (this.dramWriteSent.length > 0) {
            latestWrite = lastElement(this.dramWriteSent).value;
        }
        if (this.dramWriteCleared.length > 0) {
            latestWrite = Math.max(latestWrite, lastElement(this.dramWriteCleared).value);
        }
        return latestWrite;
    }

    earliestWaitForIncomingTiles(): number {
        let earliest = Infinity;
        for (const value of this.waitForIncomingTiles.values()) {
            earliest = Math.min(earliest, value[0].low);
        }
        return earliest;
    }

    earliestWaitForFreeTiles(): number {
        let earliest = Infinity;
        for (const value of this.waitForFreeTiles.values()) {
            earliest = Math.min(earliest, value[0].low);
        }
        return earliest;
    }

    earliestTrisc(): number {
        let earliest = Infinity;
        for (const value of this.waitForIncomingTiles.values()) {
            earliest = Math.min(earliest, value[0].low);
        }
        return earliest;
    }

    earliestTriscStallOnDram(): number {
        let earliest = Infinity;
        for (const value of this.triscStallOnDramUnpacker.values()) {
            earliest = Math.min(earliest, value[0].low);
        }
        for (const value of this.triscStallOnDramPacker.values()) {
            earliest = Math.min(earliest, value[0].low);
        }
        return earliest;
    }

    latestTriscStallOnDram(): number {
        let latest = 0;
        for (const value of this.triscStallOnDramUnpacker.values()) {
            latest = Math.max(latest, lastElement(value).high);
        }
        for (const value of this.triscStallOnDramPacker.values()) {
            latest = Math.max(latest, lastElement(value).high);
        }
        return latest;
    }

    /** Calculate candlestick bounds based on start/end cycles of the whole test */
    calculateBounds(): void {
        this.bounds = { low: 0, high: 0 };

        if (!isNumber(this.unpackerFirstBlockDataAvailable) || !isNumber(this.packFinishLastOuterLoop)) {
            this.outOfMemory = true;
        }
        // low / high are just lowest and highest values, no median for core op
        this.bounds.low = this.unpackerFirstBlockDataAvailable;
        this.bounds.high = this.packFinishLastOuterLoop;
    }

    setLeftBound(leftBound: number): void {
        this.leftBound = leftBound;
        this.dramReadIssued.forEach((line: Line) => (line.leftBound = leftBound));
        this.dramReadFlushed.forEach((line: Line) => (line.leftBound = leftBound));
        this.dramWriteSent.forEach((line: Line) => (line.leftBound = leftBound));
        this.dramWriteCleared.forEach((line: Line) => (line.leftBound = leftBound));
        for (const key of this.waitForIncomingTiles.keys()) {
            for (const rect of this.waitForIncomingTiles.get(key)!) {
                rect.leftBound = leftBound;
            }
        }

        for (const key of this.waitForFreeTiles.keys()) {
            for (const rect of this.waitForFreeTiles.get(key)!) {
                rect.leftBound = leftBound;
            }
        }

        for (const key of this.triscStallOnDramUnpacker.keys()) {
            for (const rect of this.triscStallOnDramUnpacker.get(key)!) {
                rect.leftBound = leftBound;
            }
        }

        for (const key of this.triscStallOnDramPacker.keys()) {
            for (const rect of this.triscStallOnDramPacker.get(key)!) {
                rect.leftBound = leftBound;
            }
        }
    }

    populateHostInfo(hostToDeviceMap: Record<string, number>): void {
        if (hostToDeviceMap == undefined) {
            // console.error("CoreOp: undefined host to device map when populating host info.");
            return;
        }

        const clockFrequency = hostToDeviceMap['clock-frequency'];
        const { AICLK } = hostToDeviceMap;
        const convertCyclesToNsDerived = (oldValue: number) =>
            (oldValue - this.deviceStartCycle) * (1 / clockFrequency) + this.deviceStartNs;
        const convertCyclesToNsAICLK = (oldValue: number) =>
            (oldValue - this.deviceStartCycle) * (1 / AICLK) + this.deviceStartNs;
        this.unitConversionMap.set(Unit.CYCLES, (oldValue: number) => oldValue);
        this.unitConversionMap.set(Unit.NS + Frequency.DERIVED, convertCyclesToNsDerived);
        this.unitConversionMap.set(Unit.NS + Frequency.AICLK, convertCyclesToNsAICLK);
        this.deviceStartCycle = hostToDeviceMap['start-cycle'];
        this.deviceStartNs = hostToDeviceMap['start-ns'];
        this.dramReadIssued.forEach((line: Line) => line.populateHostInfo(hostToDeviceMap));
        this.dramReadFlushed.forEach((line: Line) => line.populateHostInfo(hostToDeviceMap));
        this.dramWriteSent.forEach((line: Line) => line.populateHostInfo(hostToDeviceMap));
        this.dramWriteCleared.forEach((line: Line) => line.populateHostInfo(hostToDeviceMap));
        for (const key of this.waitForIncomingTiles.keys()) {
            for (const rect of this.waitForIncomingTiles.get(key)!) {
                rect.populateHostInfo(hostToDeviceMap);
            }
        }

        for (const key of this.waitForFreeTiles.keys()) {
            for (const rect of this.waitForFreeTiles.get(key)!) {
                rect.populateHostInfo(hostToDeviceMap);
            }
        }

        for (const key of this.triscStallOnDramUnpacker.keys()) {
            for (const rect of this.triscStallOnDramUnpacker.get(key)!) {
                rect.populateHostInfo(hostToDeviceMap);
            }
        }

        for (const key of this.triscStallOnDramPacker.keys()) {
            for (const rect of this.triscStallOnDramPacker.get(key)!) {
                rect.populateHostInfo(hostToDeviceMap);
            }
        }
    }

    populateUnitData(): void {
        if (this.unitConversionMap == undefined) {
            return;
        }

        for (const unit of this.unitConversionMap.keys()) {
            const converter = this.unitConversionMap.get(unit)!;
            const bounds = {
                low: isNumber(this.bounds.low) ? converter(this.bounds.low!) : undefined,
                high: isNumber(this.bounds.high) ? converter(this.bounds.high!) : undefined,
            };

            const opData: CoreOpData = {
                bounds,
                unpackerFirstBlockDataAvailable: isNumber(this.unpackerFirstBlockDataAvailable)
                    ? converter(this.unpackerFirstBlockDataAvailable!)
                    : undefined,
                packFinishLastOuterLoop: isNumber(this.packFinishLastOuterLoop)
                    ? converter(this.packFinishLastOuterLoop!)
                    : undefined,
                modelCycles: isNumber(this.modelCycles) ? converter(this.modelCycles!) : undefined,
                modelCyclesProp: isNumber(this.modelCycles) ? converter(this.modelCyclesProp!) : undefined,
            };

            this.unitData.set(unit, opData);

            this.dramReadIssued.forEach((line: Line) => line.populateUnitData());
            this.dramReadFlushed.forEach((line: Line) => line.populateUnitData());
            this.dramWriteSent.forEach((line: Line) => line.populateUnitData());
            this.dramWriteCleared.forEach((line: Line) => line.populateUnitData());
            for (const key of this.waitForIncomingTiles.keys()) {
                for (const rect of this.waitForIncomingTiles.get(key)!) {
                    rect.populateUnitData();
                }
            }

            for (const key of this.waitForFreeTiles.keys()) {
                for (const rect of this.waitForFreeTiles.get(key)!) {
                    rect.populateUnitData();
                }
            }

            for (const key of this.triscStallOnDramUnpacker.keys()) {
                for (const rect of this.triscStallOnDramUnpacker.get(key)!) {
                    rect.populateUnitData();
                }
            }

            for (const key of this.triscStallOnDramPacker.keys()) {
                for (const rect of this.triscStallOnDramPacker.get(key)!) {
                    rect.populateUnitData();
                }
            }
        }
    }

    switchToFrequency(frequency: string): void {
        if (!Object.values(Frequency).includes(frequency as Frequency)) {
            // console.error(`CoreOp: Can't switch to unit because target unit ${unit} does is not supported.`);
            return;
        }
        this.frequency = frequency;
        this.dramReadIssued.forEach((line: Line) => line.switchToFrequency(frequency));
        this.dramReadFlushed.forEach((line: Line) => line.switchToFrequency(frequency));
        this.dramWriteSent.forEach((line: Line) => line.switchToFrequency(frequency));
        this.dramWriteCleared.forEach((line: Line) => line.switchToFrequency(frequency));
        for (const key of this.waitForIncomingTiles.keys()) {
            for (const rect of this.waitForIncomingTiles.get(key)!) {
                rect.switchToFrequency(frequency);
            }
        }

        for (const key of this.waitForFreeTiles.keys()) {
            for (const rect of this.waitForFreeTiles.get(key)!) {
                rect.switchToFrequency(frequency);
            }
        }

        for (const key of this.triscStallOnDramUnpacker.keys()) {
            for (const rect of this.triscStallOnDramUnpacker.get(key)!) {
                rect.switchToFrequency(frequency);
            }
        }

        for (const key of this.triscStallOnDramPacker.keys()) {
            for (const rect of this.triscStallOnDramPacker.get(key)!) {
                rect.switchToFrequency(frequency);
            }
        }

        if (this.unit == Unit.NS) {
            const opData: CoreOpData | undefined = this.unitData.get(this.unit + this.frequency);
            if (!opData) {
                // console.error(`CoreOp: Can't switch to unit because no conversion found for unit ${unit}.`);
                return;
            }
            this.bounds = opData.bounds;
            this.unpackerFirstBlockDataAvailable = opData.unpackerFirstBlockDataAvailable;
            this.packFinishLastOuterLoop = opData.packFinishLastOuterLoop;
            this.modelCycles = opData.modelCycles;
            this.modelCyclesProp = opData.modelCyclesProp;
        }
    }

    switchToUnit(unit: string): void {
        if (!Object.values(Unit).includes(unit as Unit)) {
            // console.error(`CoreOp: Can't switch to unit because target unit ${unit} does is not supported.`);
            return;
        }
        const opData: CoreOpData | undefined =
            unit == Unit.CYCLES ? this.unitData.get(unit) : this.unitData.get(unit + this.frequency);
        if (!opData) {
            // console.error(`CoreOp: Can't switch to unit because no conversion found for unit ${unit}.`);
            return;
        }
        this.unit = unit;
        this.bounds = opData.bounds;
        this.unpackerFirstBlockDataAvailable = opData.unpackerFirstBlockDataAvailable;
        this.packFinishLastOuterLoop = opData.packFinishLastOuterLoop;
        this.modelCycles = opData.modelCycles;
        this.modelCyclesProp = opData.modelCyclesProp;
        this.dramReadIssued.forEach((line: Line) => line.switchToUnit(unit));
        this.dramReadFlushed.forEach((line: Line) => line.switchToUnit(unit));
        this.dramWriteSent.forEach((line: Line) => line.switchToUnit(unit));
        this.dramWriteCleared.forEach((line: Line) => line.switchToUnit(unit));
        for (const key of this.waitForIncomingTiles.keys()) {
            for (const rect of this.waitForIncomingTiles.get(key)!) {
                rect.switchToUnit(unit);
            }
        }

        for (const key of this.waitForFreeTiles.keys()) {
            for (const rect of this.waitForFreeTiles.get(key)!) {
                rect.switchToUnit(unit);
            }
        }

        for (const key of this.triscStallOnDramUnpacker.keys()) {
            for (const rect of this.triscStallOnDramUnpacker.get(key)!) {
                rect.switchToUnit(unit);
            }
        }

        for (const key of this.triscStallOnDramPacker.keys()) {
            for (const rect of this.triscStallOnDramPacker.get(key)!) {
                rect.switchToUnit(unit);
            }
        }
    }
}

export default class PerCoreD3Controller {
    d3Ref: HTMLDivElement;

    visProps: PerfDumpVisProps;

    folderMap: PerfDumpFolderMap;

    data: Map<string, Record<string, any>>; // perf dump data

    modelData: Map<string, Record<string, any>> | null; // summary with model numbers

    hostData: Map<string, Record<string, any>> | null; // host event data

    folderPaths: string[]; // folder paths we want to plot

    allFolderPaths: string[]; // All existing folder paths

    inputs: string[]; // This is the input index of interest when visualizing ops with multiple inputs

    allInputs: string[];

    allProcesses: string[];

    hasNcrisc: boolean; // Check if silicon data contains NCRISC data

    showTrisc: boolean;

    svg: any; // main SVG reference

    plotSvg: any; // SVG that contains bars and x axis, child of main SVG reference

    zoom: any; // reference to zoom transformer

    zoomScale: number;

    frequency: string;

    unit: string;

    // references to various groups of elements that need to be moved, zoomed, etc.
    opBars: any; // "g" element holding op bars

    opNames: any; // "g" element holding op names

    xAxisg: any; // "g" element holding X axis

    legend: any; // "g" element holding legend

    // Ops
    opMap: Record<string, CoreOp>;

    // folderPathInputOpMap[folderPath][input-id] are all the ops from folderpath containing data of input input-id
    folderPathInputOpMap: Record<string, Record<string, CoreOp[]>>;

    folderPathAllCoreOpsMap: Record<string, CoreOp[]>;

    coreOpsToPlot: { [core: string]: { [input: string]: CoreOp[] } }; // coreOpsToPlot[core][input] contains all ops of that core and that input

    cores: string[]; // all cores to print in op names

    hostEventMap: Record<string, HostEvent[]>;

    hostEventsToPlot: HostEvent[];

    folderPathHostToDeviceMap: Record<string, Record<number, Record<string, number>>>;

    hostEventCoreOpIndexMap: Record<string, number>;

    opColors: Record<string, string>; // Colors of ops

    inputColors: CallableFunction;

    hostEventColors: CallableFunction;

    // Bounds of the chart, based on what was found in the data
    startCycle: number;

    endCycle: number;

    // origina and current X scale
    xScale: any;

    currentXScale: any;

    xAxis: any;

    showHost: boolean;

    // Draw parameters
    static MARGIN_TOP = 1; // margin at the top of the whole chart

    static MARGIN_BOTTOM = 10; // margin at the bottom of the whole chart

    static MARGIN_LEFT = 400; // margin on the left, for op names and other info

    static MARGIN_RIGHT = 30; // margin on the right, for scroll bar

    static MARGIN_SHIFT_DOWN = 20; // margin of shifting down the bars/op_names, to leave space for cycle numbers.

    FULL_W: number; // width and height of the area in which bars/lines are drawn

    FULL_H: number;

    BAR_REGION_HEIGHT: number; // height of space for one op

    BAR_HEIGHT: number; // height of single candlestick bar

    BAR_PAD_H: number; // padding height between bars

    BAR_MODEL_HEIGHT: number; // thin model reference bars underneath

    // current XY order (to prevent mismatches)
    currentXYOrder: boolean;

    constructor(
        d3Ref: HTMLDivElement,
        visProps: PerfDumpVisProps,
        folderMap: PerfDumpFolderMap,
        data: Map<string, Record<string, any>>,
        modelData: Map<string, Record<string, any>> | null,
        hostData: Map<string, Record<string, any>> | null,
    ) {
        this.d3Ref = d3Ref;
        this.visProps = visProps;
        this.folderMap = folderMap;
        this.data = data;
        this.modelData = modelData;
        this.hostData = hostData;
        this.allInputs = [...visProps.allInputs];
        // console.log(this.visProps)

        // set all inputs
        const inputRegex = /^input-(\d+)$/;

        this.allInputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
        // console.log("all inputs in per core mode: ", this.allInputs);
        this.showTrisc = true;
        this.opColors = {
            dram_read_issued: '#ff00ff',
            dram_read_flushed: '#ff99ff',
            dram_write_sent: '#668cff',
            dram_write_tile_cleared: '#666699',
            wait_for_tile: '#cc0066',
            wait_for_free_tile: '#660033',
            trisc_stall_on_dram_unpacker: '#f75d59',
            trisc_stall_on_dram_packer: '#872657',
        };
        // console.log(this.visProps)
        //
        this.setFolderPaths();
        this.setShowHost();
        this.setInputs();
        this.inputColors = d3
            .scaleLinear<string, number, unknown>()
            .domain([0, Math.max(1, this.allInputs.length - 1)])
            .range(['green', '#FFD700']);
        // Process data
        //
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
        this.calculateFlexableBounds();
        this.calculateDrawingParameters();
        this.draw();

        if (this.visProps.xyOrder) {
            this.updateXYOrder(this.visProps);
        }
        // // Set variable parmeters
        // this.update(visProps);
    }

    // Determine what folder combos to plot
    // TODO: may want to add the option to show all base folders (db click), in that case, check in this function
    setFolderPaths(): void {
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

    setInputs(): void {
        if (this.visProps.selectedInputs.includes('Show All Inputs')) {
            this.inputs = [...this.visProps.selectableInputs];
        } else {
            this.inputs = [...this.visProps.selectedInputs];
        }
        this.inputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
    }

    setShowHost(): void {
        this.showHost = this.folderPaths.some((folderPath: string) => isHostDirectory(folderPath));
    }

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

    calculateDrawingParameters(): void {
        // Calculate drawing parameters
        PerCoreD3Controller.MARGIN_TOP = this.visProps.barRegionHeight / 80;
        this.FULL_W = this.visProps.width - PerCoreD3Controller.MARGIN_LEFT;
        // Space to plot one op, can increase if the plot looks too squished
        this.BAR_REGION_HEIGHT = this.visProps.barRegionHeight;
        const panelHeight = this.visProps.height - PerCoreD3Controller.MARGIN_SHIFT_DOWN;
        // Try to fit all ops on the screen so we won't need to scroll
        this.hostEventsToPlot.forEach(
            (event: HostEvent) => (event.barHeight = this.BAR_REGION_HEIGHT * event.getBarHeightRatio()),
        );
        let rowCount = this.hostEventsToPlot.length;
        for (const core of Object.keys(this.coreOpsToPlot)) {
            for (const input of Object.keys(this.coreOpsToPlot[core])) {
                rowCount += 1;
                for (const coreOp of this.coreOpsToPlot[core][input]) {
                    coreOp.barHeight = this.BAR_REGION_HEIGHT * coreOp.getBarHeightRatio();
                }
            }
        }
        this.FULL_H = Math.max(panelHeight, rowCount * this.BAR_REGION_HEIGHT);
    }

    updateFolderPaths(newVisProps: PerfDumpVisProps): void {
        const oldFolderPaths = this.visProps.selectedFolderPaths.map((folderPath: string[]) => folderPath.join('/'));
        const newFolderPaths = newVisProps.selectedFolderPaths.map((folderPath: string[]) => folderPath.join('/'));
        const domain = this.currentXScale.domain();
        const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
        this.plotSvg.selectAll('#cycleIndicator').remove();
        d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
        this.plotSvg.selectAll('#timePoint').remove();
        this.visProps = newVisProps;
        this.setFolderPaths();
        this.setInputs();
        if (newFolderPaths.length > oldFolderPaths.length) {
            const newSelectedPath = newFolderPaths.filter((folderPath: string) => !oldFolderPaths.includes(folderPath));
            console.assert(
                newSelectedPath.length == 1,
                'Perf dump per core: Difference when a new folder path is selected should be strictly 1.',
            );
            if (isHostDirectory(newSelectedPath[0])) {
                const newHostEventsToPlot = this.hostEventMap[newSelectedPath[0]];
                if (!newHostEventsToPlot || newHostEventsToPlot.length == 0) {
                    console.error('Perf dump per core: null or empty new host events.');
                    return;
                }

                this.filterCoreOpsAndHostEvents();
                this.calculateFlexableBounds();
                this.calculateDrawingParameters();
                this.updatePlotHeight();
                this.reDrawOnHostEventSelect(newHostEventsToPlot);
                this.zoomToDomain(domain);
                indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
                return;
            }
            this.handleSelectFolderPath(newSelectedPath[0]);
            const newCoreOpsToPlot = {};
            for (const input of this.inputs) {
                // TODO: Add error checking
                const coreOps = this.folderPathInputOpMap[newSelectedPath[0]][input];
                if (!Array.isArray(coreOps)) {
                    continue;
                }
                for (const coreOp of coreOps) {
                    const core = coreOp.getCoreString();
                    if (newCoreOpsToPlot[core]) {
                        if (newCoreOpsToPlot[core][input]) {
                            newCoreOpsToPlot[core][input].push(coreOp);
                        } else if (!newCoreOpsToPlot[core][input]) {
                            newCoreOpsToPlot[core][input] = [coreOp];
                        }
                    } else if (!newCoreOpsToPlot[core]) {
                        newCoreOpsToPlot[core] = {};
                        newCoreOpsToPlot[core][input] = [coreOp];
                    }
                }
            }
            if (Object.keys(newCoreOpsToPlot).length == 0) {
                return;
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpSelect(newCoreOpsToPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        } else if (newFolderPaths.length < oldFolderPaths.length) {
            const deSelectedPath = oldFolderPaths.filter((folderPath: string) => !newFolderPaths.includes(folderPath));
            console.assert(
                deSelectedPath.length == 1,
                'Perf dump per core: Difference when a new folder path is deselected should be strictly 1.',
            );
            if (isHostDirectory(deSelectedPath[0])) {
                const hostEventsToRemoveFromPlot = this.hostEventMap[deSelectedPath[0]];
                if (!hostEventsToRemoveFromPlot || hostEventsToRemoveFromPlot.length == 0) {
                    console.error('Perf dump per core: null or empty new host events.');
                    return;
                }
                this.filterCoreOpsAndHostEvents();
                this.calculateFlexableBounds();
                this.calculateDrawingParameters();
                this.updatePlotHeight();
                this.reDrawOnHostEventDeselect(hostEventsToRemoveFromPlot);
                this.zoomToDomain(domain);
                indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
                return;
            }
            const coreOpsToRemoveFromPlot: CoreOp[] = this.folderPathAllCoreOpsMap[deSelectedPath[0]];
            delete this.folderPathAllCoreOpsMap[deSelectedPath[0]];
            delete this.folderPathInputOpMap[deSelectedPath[0]];
            if (!coreOpsToRemoveFromPlot || coreOpsToRemoveFromPlot.length == 0) {
                console.error('Perf dump per core: null or empty core ops to remove.');
                return;
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpDeselect(coreOpsToRemoveFromPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        }
    }

    // on selected epochs, selected inputs changes
    updateInputs(newVisProps: PerfDumpVisProps): void {
        const oldInputs = this.inputs;
        this.visProps = newVisProps;
        this.setInputs();
        const newInputs = this.inputs;
        const domain = this.currentXScale.domain();
        const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
        this.plotSvg.selectAll('#cycleIndicator').remove();
        d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
        this.plotSvg.selectAll('#timePoint').remove();
        if (newInputs.length > oldInputs.length) {
            const newCoreOpsToPlot: Record<string, Record<string, CoreOp[]>> = {};
            const newSelectedInputs = newInputs.filter((input: string) => !oldInputs.includes(input));
            for (const folderPath of this.folderPaths) {
                if (isHostDirectory(folderPath)) {
                    continue;
                }
                for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                    if (newSelectedInputs.includes(coreOp.input)) {
                        const core = coreOp.getCoreString();
                        if (newCoreOpsToPlot[core]) {
                            if (newCoreOpsToPlot[core][coreOp.input]) {
                                newCoreOpsToPlot[core][coreOp.input].push(coreOp);
                            } else if (!newCoreOpsToPlot[core][coreOp.input]) {
                                newCoreOpsToPlot[core][coreOp.input] = [coreOp];
                            }
                        } else if (!newCoreOpsToPlot[core]) {
                            newCoreOpsToPlot[core] = {};
                            newCoreOpsToPlot[core][coreOp.input] = [coreOp];
                        }
                    }
                }
            }
            if (Object.keys(newCoreOpsToPlot).length == 0) {
                console.warn('Perf dump per core: null or empty new ops in new input selection.');
                return;
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpSelect(newCoreOpsToPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        } else if (newInputs.length < oldInputs.length) {
            const deSelectedInputs = oldInputs.filter((input: string) => !newInputs.includes(input));
            const coreOpsToRemoveFromPlot: CoreOp[] = [];
            for (const folderPath of this.folderPaths) {
                if (isHostDirectory(folderPath)) {
                    continue;
                }
                for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                    if (deSelectedInputs.includes(coreOp.input)) {
                        coreOpsToRemoveFromPlot.push(coreOp);
                    }
                }
            }
            if (coreOpsToRemoveFromPlot.length == 0) {
                console.error('Perf dump per core: empty ops to remove in input deselection.');
            }
            this.filterCoreOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpDeselect(coreOpsToRemoveFromPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        }
        // this.filterCoreOpsAndHostEvents();
        // this.calculateFlexableBounds();
        // this.calculateDrawingParameters();
        // this.draw();
    }

    // on show dram reads, show dram writes, show model numbers changes.
    // TODO: update so that we don't need to redraw
    updateDisplayEvents(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        const domain = this.currentXScale.domain();
        const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
        this.plotSvg.selectAll('#cycleIndicator').remove();
        d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
        this.plotSvg.selectAll('#timePoint').remove();
        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            this.folderPathAllCoreOpsMap[folderPath].forEach((coreOp: CoreOp) => (coreOp.visProps = newVisProps));
        }
        this.calculateFlexableBounds();
        this.calculateDrawingParameters();
        this.draw();
        this.zoomToDomain(domain);
        indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
    }

    // on height, width changes
    resizeSVG(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        const domain = this.currentXScale.domain();
        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            this.folderPathAllCoreOpsMap[folderPath].forEach((coreOp: CoreOp) => (coreOp.visProps = newVisProps));
        }
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
    updateBarHeight(newVisProps: PerfDumpVisProps): void {
        const domain = this.currentXScale.domain();
        this.visProps = newVisProps;
        this.calculateDrawingParameters();
        this.updatePlotHeight();
        this.calculateDrawingParameters();
        const bar_top = (op: CoreOp): number => {
            if (op.outOfMemory) {
                return 0;
            }
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            let sentHeight = 0;
            let clearedHeight = 0;
            if (op.dramWriteSent.length > 0 && this.visProps.showAllDramWrites) {
                sentHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites) {
                clearedHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }

            const prevBarHeights = issuedHeight + flushedHeight + sentHeight + clearedHeight;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_modelTop = (op: CoreOp): number => (!op.outOfMemory ? bar_top(op) + op.barHeight : 0);
        const bar_modelPropTop = (op: CoreOp): number => (!op.outOfMemory ? bar_modelTop(op) + op.barHeight / 2 : 0);

        const bar_top_issued = (): number => {
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_top_flushed = (coreOp: CoreOp): number => {
            let issuedHeight = 0;
            if (coreOp.dramReadIssued.length > 0) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + issuedHeight + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_top_sent = (coreOp: CoreOp): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            if (coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            const prevBarHeights = issuedHeight + flushedHeight;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_top_cleared = (coreOp: CoreOp): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            let sentHeight = 0;
            if (coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            if (coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            if (coreOp.dramWriteSent.length > 0) {
                sentHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            const prevBarHeights = issuedHeight + flushedHeight + sentHeight;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        // Calculate y coordinate of wait for incoming tiles
        const bar_top_incoming = (coreOp: CoreOp, prevNumWaitForIncomingTiles: number): number => {
            const issuedHeight =
                coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const flushedHeight =
                coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const sentHeight =
                coreOp.dramWriteSent.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const clearedHeight =
                coreOp.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight;
            const prevModelHeights = this.visProps.showModelNumbers ? coreOp.barHeight : 0;
            const prevIncomingHeights =
                prevNumWaitForIncomingTiles * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevBarHeights =
                issuedHeight +
                flushedHeight +
                sentHeight +
                clearedHeight +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        // Calculate y coordinate of wait for free tiles
        const bar_top_free = (coreOp: CoreOp, prevNumWaitForFreeTiles: number): number => {
            const issuedHeight =
                coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const flushedHeight =
                coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const sentHeight =
                coreOp.dramWriteSent.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const clearedHeight =
                coreOp.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight;
            const prevModelHeights = this.visProps.showModelNumbers ? coreOp.barHeight : 0;
            const prevIncomingHeights =
                coreOp.waitForIncomingTiles.size * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevFreeHeights = prevNumWaitForFreeTiles * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevBarHeights =
                issuedHeight +
                flushedHeight +
                sentHeight +
                clearedHeight +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_top_unpacker = (op: CoreOp, triscStallOnDramUnpackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = op.waitForIncomingTiles.size * (PerCoreD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = op.waitForFreeTiles.size * (PerCoreD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallUnpackerHeights =
                triscStallOnDramUnpackerId * (PerCoreD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerCoreD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                +prevFreeHeights +
                prevTriscStallUnpackerHeights +
                PerCoreD3Controller.MARGIN_TOP
            );
        };

        const bar_top_packer = (op: CoreOp, triscStallOnDramPackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = op.waitForIncomingTiles.size * (PerCoreD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = op.waitForFreeTiles.size * (PerCoreD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallUnpackerHeights =
                op.triscStallOnDramUnpacker.size * (PerCoreD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallPackerHeights =
                triscStallOnDramPackerId * (PerCoreD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerCoreD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights +
                prevTriscStallUnpackerHeights +
                prevTriscStallPackerHeights +
                PerCoreD3Controller.MARGIN_TOP
            );
        };

        // host events
        for (const event of this.hostEventsToPlot) {
            this.opBars
                .selectAll(`.host-event-${event.id}`)
                .attr('y', PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_TOP)
                .attr('height', event.barHeight);
        }

        this.opBars
            .selectAll('#pd-candle-bar')
            .attr('y', (op: CoreOp) => bar_top(op))
            .attr('height', (coreOp: CoreOp) => coreOp.barHeight);

        if (this.visProps.showModelNumbers) {
            this.opBars
                .selectAll('#pd-candle-bar-model')
                .attr('y', (op: CoreOp) => (!op.outOfMemory && isNumber(op.modelCycles) ? bar_modelTop(op) : 0))
                .attr('height', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCycles) ? coreOp.barHeight / 2 : 0,
                );

            this.opBars
                .selectAll('#pd-candle-bar-model-prop')
                .attr('y', (op: CoreOp) => (!op.outOfMemory && isNumber(op.modelCyclesProp) ? bar_modelPropTop(op) : 0))
                .attr('height', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCyclesProp) ? coreOp.barHeight / 2 : 0,
                );
        }

        for (const core of Object.keys(this.coreOpsToPlot)) {
            for (const input of Object.keys(this.coreOpsToPlot[core])) {
                for (const coreOp of this.coreOpsToPlot[core][input]) {
                    if (coreOp.dramReadIssued.length > 0) {
                        this.opBars
                            .selectAll(`.dram-read-issued-core-op-id-${coreOp.id}`)
                            .attr('y1', bar_top_issued())
                            .attr('y2', bar_top_issued() + coreOp.barHeight / 2);
                    }
                    if (coreOp.dramReadFlushed.length > 0) {
                        this.opBars
                            .selectAll(`.dram-read-flushed-core-op-id-${coreOp.id}`)
                            .attr('y1', bar_top_flushed(coreOp))
                            .attr('y2', bar_top_flushed(coreOp) + coreOp.barHeight / 2);
                    }
                    if (coreOp.dramWriteSent.length > 0) {
                        this.opBars
                            .selectAll(`.dram-write-sent-core-op-id-${coreOp.id}`)
                            .attr('y1', bar_top_sent(coreOp))
                            .attr('y2', bar_top_sent(coreOp) + coreOp.barHeight / 2);
                    }
                    if (coreOp.dramWriteCleared.length > 0) {
                        this.opBars
                            .selectAll(`.dram-write-cleared-core-op-id-${coreOp.id}`)
                            .attr('y1', bar_top_cleared(coreOp))
                            .attr('y2', bar_top_cleared(coreOp) + coreOp.barHeight / 2);
                    }
                    if (coreOp.waitForIncomingTiles.size > 0 && coreOp.showWaitForTile) {
                        for (
                            let waitForIncomingTileId = 0;
                            waitForIncomingTileId < coreOp.waitForIncomingTiles.size;
                            waitForIncomingTileId++
                        ) {
                            this.opBars
                                .selectAll(
                                    `.core-op-id-${coreOp.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId}`,
                                )
                                .attr('y', bar_top_incoming(coreOp, waitForIncomingTileId))
                                .attr('height', coreOp.barHeight);
                        }
                    }
                    if (coreOp.waitForFreeTiles.size > 0 && coreOp.showWaitForTile) {
                        for (
                            let waitForFreeTileId = 0;
                            waitForFreeTileId < coreOp.waitForFreeTiles.size;
                            waitForFreeTileId++
                        ) {
                            this.opBars
                                .selectAll(`.core-op-id-${coreOp.id}-wait-for-free-tiles-id-${waitForFreeTileId}`)
                                .attr('y', bar_top_free(coreOp, waitForFreeTileId))
                                .attr('height', coreOp.barHeight);
                        }
                    }
                    if (coreOp.triscStallOnDramUnpacker.size > 0) {
                        for (
                            let triscStallOnDramUnpackerId = 0;
                            triscStallOnDramUnpackerId < coreOp.triscStallOnDramUnpacker.size;
                            triscStallOnDramUnpackerId++
                        ) {
                            this.opBars
                                .selectAll(
                                    `.coreOp-id-${coreOp.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId}`,
                                )
                                .attr('y', bar_top_unpacker(coreOp, triscStallOnDramUnpackerId))
                                .attr('height', coreOp.barHeight);
                        }
                    }
                    if (coreOp.triscStallOnDramPacker.size > 0) {
                        for (
                            let triscStallOnDramPackerId = 0;
                            triscStallOnDramPackerId < coreOp.triscStallOnDramPacker.size;
                            triscStallOnDramPackerId++
                        ) {
                            this.opBars
                                .selectAll(
                                    `.coreOp-id-${coreOp.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId}`,
                                )
                                .attr('y', bar_top_packer(coreOp, triscStallOnDramPackerId))
                                .attr('height', coreOp.barHeight);
                        }
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
        this.updateDeviceBarSeparators();
        this.updateDeviceOpNames();
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
        this.calculateFlexableBounds();
        this.updateXScaleDomainAndApplyToBars();
    }

    updateUnit(newUnit: Unit): void {
        this.visProps.unit = newUnit;
        this.unit = this.visProps.unit;
        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            this.folderPathAllCoreOpsMap[folderPath].forEach((coreOp: CoreOp) => coreOp.switchToUnit(this.unit));
        }
        this.calculateFlexableBounds();
        this.updateXScaleDomainAndApplyToBars();
    }

    updateXYOrder(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;

        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                coreOp.xyOrder = this.visProps.xyOrder;
            }
        }

        // console.log(this.coreOpsToPlot);

        const temp = {};
        for (const key of Object.keys(this.coreOpsToPlot)) {
            const t = key.split('-');
            temp[`${t[1]}-${t[0]}`] = this.coreOpsToPlot[key];
        }
        this.coreOpsToPlot = temp;
        this.cores = Object.keys(this.coreOpsToPlot);
        this.cores.sort(sortCores);

        let index = 0;
        for (const core of this.cores) {
            for (const input of this.inputs) {
                for (const coreOp of this.coreOpsToPlot[core][input]) {
                    this.hostEventCoreOpIndexMap[coreOp.id] = index;
                }
                index += 1;
            }
        }

        this.updateHostEventNames();
        this.updateDeviceOpNames();
        this.draw();
    }

    parseOpName(name: string): [string, number, number] {
        const regex = /^(\d+)-(\d+)-(\S+)$/;
        const m = name.match(regex);
        if (m === null) {
            // errors.push("Op {op_name} has invalid name pattern.");
            // console.error("Op name parsing error: ", name, m);
            return ['', 0, 0];
        }

        return [m[3], parseInt(m[1]), parseInt(m[2])];
    }

    handleSelectFolderPath(newFolderPath: string): void {
        if (this.data == null || !this.data.has(newFolderPath)) {
            console.error(
                "Perf dump per core handle select folder path: Shouldn't get here, all paths should be host directories",
            );
            return;
        }
        const folderPathInputOpMap = {};
        const folderPathAllCoreOpsMap = {};
        folderPathInputOpMap[newFolderPath] = {};
        folderPathAllCoreOpsMap[newFolderPath] = [];
        const deviceId: number =
            this.data.get(newFolderPath)!['per-epoch-events'] &&
            this.data.get(newFolderPath)!['per-epoch-events']['device-id'];
        for (const [op_name, op_data] of Object.entries(this.data.get(newFolderPath)!)) {
            for (const input of this.allInputs) {
                const [name, x, y] = this.parseOpName(op_name);
                let graphId = getGraphId(newFolderPath);
                let epochId = '';
                if (graphId == '') {
                    graphId = 'N/A';
                    epochId = getEpochId(newFolderPath);
                    if (epochId == '') {
                        console.error("Couldn't find epoch Id or graph Id in per core mode, shouldn't happen!");
                        continue;
                    }
                }
                if (
                    name == '' ||
                    !op_data['per-thread-events'] ||
                    !op_data['per-thread-events'][input] ||
                    op_data['per-thread-events'][input] == 'N/A'
                ) {
                    continue;
                }

                const inputNum = parseInt(input.split('-').pop()!);
                // Find unique ops that may be performed on multiple cores
                const coreOp = new CoreOp(
                    name,
                    newFolderPath,
                    deviceId,
                    graphId,
                    { x, y },
                    input,
                    op_data['core-op-id'],
                    this.visProps,
                    isNumber(parseInt(epochId)) ? parseInt(epochId) : null,
                );

                folderPathAllCoreOpsMap[newFolderPath].push(coreOp);
                // full_name should be unique, every core op should have a different full name
                const full_name = `${op_name}-path-${newFolderPath}-in${input}`;
                this.opMap[full_name] = coreOp;

                if (folderPathInputOpMap[newFolderPath][input] == undefined) {
                    folderPathInputOpMap[newFolderPath][input] = [coreOp];
                } else if (folderPathInputOpMap[newFolderPath][input] != undefined) {
                    folderPathInputOpMap[newFolderPath][input].push(coreOp);
                }

                // TODO: add checking for whether this exists
                const perf = op_data['per-thread-events'][input];

                // Start end time of green bars
                const unpackerFirstBlockDataAvailable =
                    perf['unpacker-first-block-data-available'] || perf['unpack-first-block-data-available'];
                const packFinishLastOuterLoop = perf['pack-finish-last-outer-loop'] || perf['pack-end-outer-loop'];
                if (isNumber(unpackerFirstBlockDataAvailable)) {
                    coreOp.unpackerFirstBlockDataAvailable = unpackerFirstBlockDataAvailable;
                }
                if (isNumber(packFinishLastOuterLoop)) {
                    coreOp.packFinishLastOuterLoop = packFinishLastOuterLoop;
                }

                // math utilization
                const mathUtilization = perf['math-utilization-first-unpack-to-last-pack'];
                if (isNumber(mathUtilization)) {
                    coreOp.mathUtilization = mathUtilization;
                }

                // unpack bandwidth
                const unpackBwNames: string[] = [];
                for (const field of Object.keys(perf)) {
                    if (field.startsWith('unpack-') && field.endsWith('-bw')) {
                        unpackBwNames.push(field);
                    }
                }
                unpackBwNames.sort((a: string, b: string) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]));
                for (const ub of unpackBwNames) {
                    // assign numbers to coreOp unpack bandwidths
                    coreOp.unpackBw[ub] = isNumber(perf[ub]) ? perf[ub] : undefined;
                }

                // pack bandwidth
                coreOp.packBw = isNumber(perf['pack-bw']) ? perf['pack-bw'] : undefined;

                // wait for tiles
                const dataT0 = !op_data.T0 ? {} : op_data.T0;
                const waitForTile = new Map<string, Rect[]>();
                const waitForTileRegex = /^wait-for-incoming-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                for (const field of Object.keys(dataT0)) {
                    const m = field.match(waitForTileRegex);
                    if (m != null) {
                        const outerLoop = parseInt(m[1]);
                        // check if wait for incoming tile outer loop belongs to this input
                        if (outerLoop != inputNum) {
                            continue;
                        }
                        const starts = dataT0[field].start;
                        const ends = dataT0[field].end;
                        if (!Array.isArray(starts) || !Array.isArray(ends)) {
                            continue;
                        }
                        if (starts.length !== ends.length) {
                            console.error(
                                `Number of start time stamps does not match number of end time stamps in ${field} of op ${op_name}`,
                            );
                            continue;
                        }

                        const rects: Rect[] = [];
                        for (let i = 0; i < starts.length && i < ends.length; i++) {
                            const rect = new Rect(starts[i], ends[i]);
                            rects.push(rect);
                        }
                        waitForTile.set(field, rects);
                    }
                }

                // wait for free tiles
                const dataT2 = !op_data.T2 ? {} : op_data.T2;
                const waitForFreeTile = new Map<string, Rect[]>();
                const waitForFreeTileRegex = /^wait-for-free-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                for (const field of Object.keys(dataT2)) {
                    const m = field.match(waitForFreeTileRegex);
                    if (m != null) {
                        const outerLoop = parseInt(m[1]);
                        // Check if wait for free tile outer loop belongs to this input
                        if (outerLoop != inputNum) {
                            continue;
                        }
                        const starts = dataT2[field].start;
                        const ends = dataT2[field].end;
                        if (!Array.isArray(starts) || !Array.isArray(ends)) {
                            continue;
                        }
                        if (starts.length !== ends.length) {
                            console.error(
                                `Number of start time stamps does not match number of end time stamps in ${field} of op ${op_name}`,
                            );
                            continue;
                        }

                        const rects: Rect[] = [];
                        for (let i = 0; i < starts.length && i < ends.length; i++) {
                            const rect = new Rect(starts[i], ends[i]);
                            rects.push(rect);
                        }
                        waitForFreeTile.set(field, rects);
                    }
                }

                coreOp.waitForIncomingTiles = new Map(
                    [...waitForTile].sort((a, b) => {
                        const operand_a = parseInt(a[0].match(waitForTileRegex)![2]);
                        const operand_b = parseInt(b[0].match(waitForTileRegex)![2]);
                        return operand_a - operand_b;
                    }),
                );

                coreOp.waitForFreeTiles = new Map(
                    [...waitForFreeTile].sort((a, b) => {
                        const operand_a = parseInt(a[0].match(waitForFreeTileRegex)![2]);
                        const operand_b = parseInt(b[0].match(waitForFreeTileRegex)![2]);
                        return operand_a - operand_b;
                    }),
                );

                // trisc stall on dram
                const triscStallOnDramUnpacker = new Map<string, Rect[]>();
                const triscStallOnDramRegex =
                    /^trisc-stall-on-dram-perf-dump-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                for (const field of Object.keys(dataT0)) {
                    const m = field.match(triscStallOnDramRegex);
                    if (m != null) {
                        const outerLoop = parseInt(m[1]);
                        // check if wait for incoming tile outer loop belongs to this input
                        if (outerLoop != inputNum) {
                            continue;
                        }
                        const starts = dataT0[field].start;
                        const ends = dataT0[field].end;
                        if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length == 0 || ends.length == 0) {
                            continue;
                        }
                        if (starts.length != ends.length) {
                            console.error(
                                `Number of start time stamps trisc stall does not match number of end time stamps in ${field} of op ${op_name}`,
                            );
                            continue;
                        }

                        const rects: Rect[] = [];
                        for (let i = 0; i < starts.length && i < ends.length; i++) {
                            const rect = new Rect(starts[i], ends[i]);
                            rects.push(rect);
                        }
                        triscStallOnDramUnpacker.set(field, rects);
                    }
                }

                const triscStallOnDramPacker = new Map<string, Rect[]>();
                for (const field of Object.keys(dataT2)) {
                    const m = field.match(triscStallOnDramRegex);
                    if (m != null) {
                        const outerLoop = parseInt(m[1]);
                        // check if wait for incoming tile outer loop belongs to this input
                        if (outerLoop != inputNum) {
                            continue;
                        }
                        const starts = dataT2[field].start;
                        const ends = dataT2[field].end;
                        if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length == 0 || ends.length == 0) {
                            continue;
                        }
                        if (starts.length != ends.length) {
                            console.error(
                                `Number of start time stamps trisc stall does not match number of end time stamps in ${field} of op ${op_name}`,
                            );
                            continue;
                        }

                        const rects: Rect[] = [];
                        for (let i = 0; i < starts.length && i < ends.length; i++) {
                            const rect = new Rect(starts[i], ends[i]);
                            rects.push(rect);
                        }
                        triscStallOnDramPacker.set(field, rects);
                    }
                }

                coreOp.triscStallOnDramUnpacker = new Map(
                    [...triscStallOnDramUnpacker].sort((a, b) => {
                        const operand_a = parseInt(a[0].match(triscStallOnDramRegex)![2]);
                        const operand_b = parseInt(b[0].match(triscStallOnDramRegex)![2]);
                        return operand_a - operand_b;
                    }),
                );

                coreOp.triscStallOnDramPacker = new Map(
                    [...triscStallOnDramPacker].sort((a, b) => {
                        const operand_a = parseInt(a[0].match(triscStallOnDramRegex)![2]);
                        const operand_b = parseInt(b[0].match(triscStallOnDramRegex)![2]);
                        return operand_a - operand_b;
                    }),
                );

                const ncriscData = op_data.NCRISC;
                if (ncriscData) {
                    const fields = Object.keys(ncriscData);
                    for (const field of fields) {
                        if (field.startsWith('dram-read-stream-')) {
                            if (Array.isArray(ncriscData[field]['chunk-read-issued'])) {
                                coreOp.dramReadIssued = coreOp.dramReadIssued.concat(
                                    ncriscData[field]['chunk-read-issued'].map((cycle: number) => new Line(cycle)),
                                );
                            }
                            if (Array.isArray(ncriscData[field]['tiles-flushed'])) {
                                coreOp.dramReadFlushed = coreOp.dramReadFlushed.concat(
                                    ncriscData[field]['tiles-flushed'].map((cycle: number) => new Line(cycle)),
                                );
                            }
                        } else if (
                            field.startsWith('dram-write-sent-stream-') &&
                            Array.isArray(ncriscData[field].end)
                        ) {
                            coreOp.dramWriteSent = coreOp.dramWriteSent.concat(
                                ncriscData[field].end.map((cycle: number) => new Line(cycle)),
                            );
                        } else if (
                            field.startsWith('dram-write-tile-cleared-stream-') &&
                            Array.isArray(ncriscData[field].end)
                        ) {
                            coreOp.dramWriteCleared = coreOp.dramWriteCleared.concat(
                                ncriscData[field].end.map((cycle: number) => new Line(cycle)),
                            );
                        }
                    }
                }
            }
        }

        if (this.modelData && this.modelData.has(newFolderPath)) {
            for (const [op_name, model_data] of Object.entries(this.modelData.get(newFolderPath)!)) {
                for (const input of this.allInputs) {
                    const [name, x, y] = this.parseOpName(op_name);
                    if (name == '' || !model_data[input] || model_data[input] == 'N/A') {
                        continue;
                    }
                    const full_name = `${op_name}-path-${newFolderPath}-in${input}`;
                    const op = this.opMap[full_name];
                    if (op === undefined) {
                        console.error('Per core mode: OP NOT FOUND IN OPMAP WHEN TRYING TO SET MODEL NUMBERS');
                        continue;
                    }
                    // TODO: what to display when out of memory model data
                    op.modelCycles = isNumber(model_data[input]['model-cycles-per-core'])
                        ? model_data[input]['model-cycles-per-core']
                        : undefined;
                    op.modelCyclesProp = isNumber(model_data[input]['model-prop-cycles-per-core'])
                        ? model_data[input]['model-prop-cycles-per-core']
                        : undefined;
                }
            }
        }

        const matchingHostPath = Object.keys(this.folderPathHostToDeviceMap).find((hostPath: string) =>
            newFolderPath.startsWith(hostPath.split('/').slice(0, -1).join('/')),
        );
        for (const folderPath of Object.keys(folderPathAllCoreOpsMap)) {
            for (const coreOp of folderPathAllCoreOpsMap[folderPath]) {
                coreOp.sortNcriscEvents();
                coreOp.calculateBounds();
                if (matchingHostPath != undefined) {
                    coreOp.populateHostInfo(this.folderPathHostToDeviceMap[matchingHostPath][coreOp.deviceId]);
                    coreOp.populateUnitData();
                    // default unit for these new ops is cycles, if the current user-selected unit is ns, switch these ops to use ns numbers.
                    this.unit != Unit.CYCLES && coreOp.switchToUnit(this.unit);
                    // default frequency for these new ops is derived, if the current user-selected frequency is AICLK, switch these ops to use AICLK.
                    this.frequency != Frequency.DERIVED && coreOp.switchToFrequency(this.frequency);
                }
            }
        }

        this.folderPathAllCoreOpsMap = {
            ...this.folderPathAllCoreOpsMap,
            ...folderPathAllCoreOpsMap,
        };
        this.folderPathInputOpMap = {
            ...this.folderPathInputOpMap,
            ...folderPathInputOpMap,
        };
    }

    processData(): void {
        this.opMap = {};
        this.folderPathAllCoreOpsMap = {};
        this.folderPathInputOpMap = {};
        this.hostEventMap = {};
        this.folderPathHostToDeviceMap = {};
        for (const folderPath of this.allFolderPaths) {
            if (isHostDirectory(folderPath)) {
                if (this.hostData == null) {
                    console.error('Per-core: host directory selected but null host data.');
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
                console.error(
                    "Perf dump per core process data: Shouldn't get here, all paths should be host directories",
                );
                continue;
            }
            this.folderPathInputOpMap[folderPath] = {};
            this.folderPathAllCoreOpsMap[folderPath] = [];
            const deviceId: number =
                this.data.get(folderPath)!['per-epoch-events'] &&
                this.data.get(folderPath)!['per-epoch-events']['device-id'];
            for (const [op_name, op_data] of Object.entries(this.data.get(folderPath)!)) {
                for (const input of this.allInputs) {
                    const [name, x, y] = this.parseOpName(op_name);
                    let graphId = getGraphId(folderPath);
                    let epochId = '';
                    if (graphId == '') {
                        graphId = 'N/A';
                        epochId = getEpochId(folderPath);
                        if (epochId == '') {
                            console.error("Couldn't find epoch Id or graph Id in per core mode, shouldn't happen!");
                            continue;
                        }
                    }
                    if (
                        name == '' ||
                        !op_data['per-thread-events'] ||
                        !op_data['per-thread-events'][input] ||
                        op_data['per-thread-events'][input] == 'N/A'
                    ) {
                        continue;
                    }

                    const inputNum = parseInt(input.split('-').pop()!);
                    // Find unique ops that may be performed on multiple cores
                    const coreOp = new CoreOp(
                        name,
                        folderPath,
                        deviceId,
                        graphId,
                        { x, y },
                        input,
                        op_data['core-op-id'],
                        this.visProps,
                        isNumber(parseInt(epochId)) ? parseInt(epochId) : null,
                    );
                    this.folderPathAllCoreOpsMap[folderPath].push(coreOp);
                    // full_name should be unique, every core op should have a different full name
                    const full_name = `${op_name}-path-${folderPath}-in${input}`;
                    this.opMap[full_name] = coreOp;

                    if (this.folderPathInputOpMap[folderPath][input] == undefined) {
                        this.folderPathInputOpMap[folderPath][input] = [coreOp];
                    } else if (this.folderPathInputOpMap[folderPath][input] != undefined) {
                        this.folderPathInputOpMap[folderPath][input].push(coreOp);
                    }

                    // TODO: add checking for whether this exists
                    const perf = op_data['per-thread-events'][input];

                    // Start end time of green bars
                    const unpackerFirstBlockDataAvailable =
                        perf['unpacker-first-block-data-available'] || perf['unpack-first-block-data-available'];
                    const packFinishLastOuterLoop = perf['pack-finish-last-outer-loop'] || perf['pack-end-outer-loop'];
                    if (isNumber(unpackerFirstBlockDataAvailable)) {
                        coreOp.unpackerFirstBlockDataAvailable = unpackerFirstBlockDataAvailable;
                    }
                    if (isNumber(packFinishLastOuterLoop)) {
                        coreOp.packFinishLastOuterLoop = packFinishLastOuterLoop;
                    }

                    // math utilization
                    const mathUtilization = perf['math-utilization-first-unpack-to-last-pack'];
                    if (isNumber(mathUtilization)) {
                        coreOp.mathUtilization = mathUtilization;
                    }

                    // unpack bandwidth
                    const unpackBwNames: string[] = [];
                    for (const field of Object.keys(perf)) {
                        if (field.startsWith('unpack-') && field.endsWith('-bw')) {
                            unpackBwNames.push(field);
                        }
                    }
                    unpackBwNames.sort((a: string, b: string) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]));
                    for (const ub of unpackBwNames) {
                        // assign numbers to coreOp unpack bandwidths
                        coreOp.unpackBw[ub] = isNumber(perf[ub]) ? perf[ub] : undefined;
                    }

                    // pack bandwidth
                    coreOp.packBw = isNumber(perf['pack-bw']) ? perf['pack-bw'] : undefined;

                    // wait for tiles
                    const dataT0 = !op_data.T0 ? {} : op_data.T0;
                    const waitForTile = new Map<string, Rect[]>();
                    const waitForTileRegex = /^wait-for-incoming-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                    for (const field of Object.keys(dataT0)) {
                        const m = field.match(waitForTileRegex);
                        if (m != null) {
                            const outerLoop = parseInt(m[1]);
                            // check if wait for incoming tile outer loop belongs to this input
                            if (outerLoop != inputNum) {
                                continue;
                            }
                            const starts = dataT0[field].start;
                            const ends = dataT0[field].end;
                            if (
                                !Array.isArray(starts) ||
                                !Array.isArray(ends) ||
                                starts.length == 0 ||
                                ends.length == 0
                            ) {
                                continue;
                            }
                            if (starts.length !== ends.length) {
                                console.error(
                                    `Number of start time stamps does not match number of end time stamps in ${field} of op ${op_name}`,
                                );
                                continue;
                            }

                            const rects: Rect[] = [];
                            for (let i = 0; i < starts.length && i < ends.length; i++) {
                                const rect = new Rect(starts[i], ends[i]);
                                rects.push(rect);
                            }
                            waitForTile.set(field, rects);
                        }
                    }

                    // wait for free tiles
                    const dataT2 = !op_data.T2 ? {} : op_data.T2;
                    const waitForFreeTile = new Map<string, Rect[]>();
                    const waitForFreeTileRegex = /^wait-for-free-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                    for (const field of Object.keys(dataT2)) {
                        const m = field.match(waitForFreeTileRegex);
                        if (m != null) {
                            const outerLoop = parseInt(m[1]);
                            // Check if wait for free tile outer loop belongs to this input
                            if (outerLoop != inputNum) {
                                continue;
                            }
                            const starts = dataT2[field].start;
                            const ends = dataT2[field].end;
                            if (
                                !Array.isArray(starts) ||
                                !Array.isArray(ends) ||
                                starts.length == 0 ||
                                ends.length == 0
                            ) {
                                continue;
                            }
                            if (starts.length !== ends.length) {
                                console.error(
                                    `Number of start time stamps does not match number of end time stamps in ${field} of op ${op_name}`,
                                );
                                continue;
                            }

                            const rects: Rect[] = [];
                            for (let i = 0; i < starts.length && i < ends.length; i++) {
                                const rect = new Rect(starts[i], ends[i]);
                                rects.push(rect);
                            }
                            waitForFreeTile.set(field, rects);
                        }
                    }

                    coreOp.waitForIncomingTiles = new Map(
                        [...waitForTile].sort((a, b) => {
                            const operand_a = parseInt(a[0].match(waitForTileRegex)![2]);
                            const operand_b = parseInt(b[0].match(waitForTileRegex)![2]);
                            return operand_a - operand_b;
                        }),
                    );

                    coreOp.waitForFreeTiles = new Map(
                        [...waitForFreeTile].sort((a, b) => {
                            const operand_a = parseInt(a[0].match(waitForFreeTileRegex)![2]);
                            const operand_b = parseInt(b[0].match(waitForFreeTileRegex)![2]);
                            return operand_a - operand_b;
                        }),
                    );

                    // trisc stall on dram
                    const triscStallOnDramUnpacker = new Map<string, Rect[]>();
                    const triscStallOnDramRegex =
                        /^trisc-stall-on-dram-perf-dump-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                    for (const field of Object.keys(dataT0)) {
                        const m = field.match(triscStallOnDramRegex);
                        if (m != null) {
                            const outerLoop = parseInt(m[1]);
                            // check if wait for incoming tile outer loop belongs to this input
                            if (outerLoop != inputNum) {
                                continue;
                            }
                            const starts = dataT0[field].start;
                            const ends = dataT0[field].end;
                            if (
                                !Array.isArray(starts) ||
                                !Array.isArray(ends) ||
                                starts.length == 0 ||
                                ends.length == 0
                            ) {
                                continue;
                            }
                            if (starts.length != ends.length) {
                                console.error(
                                    `Number of start time stamps trisc stall does not match number of end time stamps in ${field} of op ${op_name}`,
                                );
                                continue;
                            }

                            const rects: Rect[] = [];
                            for (let i = 0; i < starts.length && i < ends.length; i++) {
                                const rect = new Rect(starts[i], ends[i]);
                                rects.push(rect);
                            }
                            triscStallOnDramUnpacker.set(field, rects);
                        }
                    }

                    const triscStallOnDramPacker = new Map<string, Rect[]>();
                    for (const field of Object.keys(dataT2)) {
                        const m = field.match(triscStallOnDramRegex);
                        if (m != null) {
                            const outerLoop = parseInt(m[1]);
                            // check if wait for incoming tile outer loop belongs to this input
                            if (outerLoop != inputNum) {
                                continue;
                            }
                            const starts = dataT2[field].start;
                            const ends = dataT2[field].end;
                            if (
                                !Array.isArray(starts) ||
                                !Array.isArray(ends) ||
                                starts.length == 0 ||
                                ends.length == 0
                            ) {
                                continue;
                            }
                            if (starts.length != ends.length) {
                                console.error(
                                    `Number of start time stamps trisc stall does not match number of end time stamps in ${field} of op ${op_name}`,
                                );
                                continue;
                            }

                            const rects: Rect[] = [];
                            for (let i = 0; i < starts.length && i < ends.length; i++) {
                                const rect = new Rect(starts[i], ends[i]);
                                rects.push(rect);
                            }
                            triscStallOnDramPacker.set(field, rects);
                        }
                    }

                    coreOp.triscStallOnDramUnpacker = new Map(
                        [...triscStallOnDramUnpacker].sort((a, b) => {
                            const operand_a = parseInt(a[0].match(triscStallOnDramRegex)![2]);
                            const operand_b = parseInt(b[0].match(triscStallOnDramRegex)![2]);
                            return operand_a - operand_b;
                        }),
                    );

                    coreOp.triscStallOnDramPacker = new Map(
                        [...triscStallOnDramPacker].sort((a, b) => {
                            const operand_a = parseInt(a[0].match(triscStallOnDramRegex)![2]);
                            const operand_b = parseInt(b[0].match(triscStallOnDramRegex)![2]);
                            return operand_a - operand_b;
                        }),
                    );

                    const ncriscData = op_data.NCRISC;

                    // const splitPerInput = (timeStamps: number[], numTimeStampsPerInput: number, inputID: number): number[] => {
                    //   const timeStampsPerInput = [];
                    //   const startID = numTimeStampsPerInput * inputID;
                    //   let currID = startID;
                    //   // May run out of memory so an input could have reads/writes less than expected
                    //   while (currID < startID + numTimeStampsPerInput && currID < timeStamps.length) {
                    //     timeStampsPerInput.push(timeStamps[currID]);
                    //     currID += 1;
                    //   }
                    //   return timeStampsPerInput;
                    // };
                    if (ncriscData) {
                        const fields = Object.keys(ncriscData);
                        for (const field of fields) {
                            if (field.startsWith('dram-read-stream-')) {
                                if (Array.isArray(ncriscData[field]['chunk-read-issued'])) {
                                    coreOp.dramReadIssued = coreOp.dramReadIssued.concat(
                                        ncriscData[field]['chunk-read-issued'].map((cycle: number) => new Line(cycle)),
                                    );
                                }
                                if (Array.isArray(ncriscData[field]['tiles-flushed'])) {
                                    coreOp.dramReadFlushed = coreOp.dramReadFlushed.concat(
                                        ncriscData[field]['tiles-flushed'].map((cycle: number) => new Line(cycle)),
                                    );
                                }
                            } else if (
                                field.startsWith('dram-write-sent-stream-') &&
                                Array.isArray(ncriscData[field].end)
                            ) {
                                coreOp.dramWriteSent = coreOp.dramWriteSent.concat(
                                    ncriscData[field].end.map((cycle: number) => new Line(cycle)),
                                );
                            } else if (
                                field.startsWith('dram-write-tile-cleared-stream-') &&
                                Array.isArray(ncriscData[field].end)
                            ) {
                                coreOp.dramWriteCleared = coreOp.dramWriteCleared.concat(
                                    ncriscData[field].end.map((cycle: number) => new Line(cycle)),
                                );
                            }
                        }
                        // console.log("DRAM READ CORE OPS LENGTH " + parentOp.name)
                        // console.log(parentOp.dramReadCoreOps.length)
                        // console.log("DRAM WRITE CORE OPS LENGTH " + parentOp.name)
                        // console.log(parentOp.dramWriteCoreOps.length)
                    }
                }
            }
        }

        if (this.modelData) {
            for (const folderPath of this.allFolderPaths) {
                if (!this.modelData.has(folderPath)) {
                    continue;
                }
                for (const [op_name, model_data] of Object.entries(this.modelData.get(folderPath)!)) {
                    for (const input of this.allInputs) {
                        const [name, x, y] = this.parseOpName(op_name);
                        if (name == '' || !model_data[input] || model_data[input] == 'N/A') {
                            continue;
                        }
                        const full_name = `${op_name}-path-${folderPath}-in${input}`;
                        const op = this.opMap[full_name];
                        if (op === undefined) {
                            console.error('Per core mode: OP NOT FOUND IN OPMAP WHEN TRYING TO SET MODEL NUMBERS');
                            continue;
                        }

                        // TODO: what to display when out of memory model data
                        op.modelCycles = isNumber(model_data[input]['model-cycles-per-core'])
                            ? model_data[input]['model-cycles-per-core']
                            : undefined;
                        op.modelCyclesProp = isNumber(model_data[input]['model-prop-cycles-per-core'])
                            ? model_data[input]['model-prop-cycles-per-core']
                            : undefined;
                    }
                }
            }
        }

        const hostPaths = Object.keys(this.folderPathHostToDeviceMap);
        for (const folderPath of Object.keys(this.folderPathAllCoreOpsMap)) {
            for (const coreOp of this.folderPathAllCoreOpsMap[folderPath]) {
                coreOp.sortNcriscEvents();
                coreOp.calculateBounds();
                const matchingHostPath = hostPaths.find((hostPath: string) => {
                    const hostParentPath = hostPath.split('/').slice(0, -1).join('/');
                    return coreOp.folderPath.startsWith(hostParentPath);
                });

                if (matchingHostPath != undefined) {
                    coreOp.populateHostInfo(this.folderPathHostToDeviceMap[matchingHostPath][coreOp.deviceId]);
                    coreOp.populateUnitData();
                }
            }
        }

        this.sortHostEvents();
        // console.log("EPOCH INPUT OP MAP:")
        // console.log(this.folderPathInputOpMap)
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

    // Collect coreOps that we want to plot based on epochs and inputs
    filterCoreOpsAndHostEvents(): void {
        this.coreOpsToPlot = {};
        this.cores = [];
        this.hostEventsToPlot = [];
        this.hostEventCoreOpIndexMap = {};

        for (const folderPath of this.folderPaths) {
            if (isHostDirectory(folderPath)) {
                this.hostEventsToPlot = this.hostEventsToPlot.concat(this.hostEventMap[folderPath]);
                continue;
            }
            for (const input of this.inputs) {
                const coreOps = this.folderPathInputOpMap[folderPath][input];
                if (!Array.isArray(coreOps)) {
                    continue;
                }
                for (const coreOp of coreOps) {
                    const core = coreOp.getCoreString();
                    if (this.coreOpsToPlot[core]) {
                        if (this.coreOpsToPlot[core][input]) {
                            this.coreOpsToPlot[core][input].push(coreOp);
                        } else if (!this.coreOpsToPlot[core][input]) {
                            this.coreOpsToPlot[core][input] = [coreOp];
                        }
                    } else if (!this.coreOpsToPlot[core]) {
                        this.coreOpsToPlot[core] = {};
                        this.coreOpsToPlot[core][input] = [coreOp];
                    }
                }
            }
        }

        this.cores = Object.keys(this.coreOpsToPlot);
        this.cores.sort(sortCores);
        let index = 0;
        for (const event of this.hostEventsToPlot) {
            this.hostEventCoreOpIndexMap[event.fullName] = index;
            index += 1;
        }
        for (const core of this.cores) {
            for (const input of this.inputs) {
                for (const coreOp of this.coreOpsToPlot[core][input]) {
                    this.hostEventCoreOpIndexMap[coreOp.id] = index;
                }
                index += 1;
            }
        }
    }

    calculateFlexableBounds(): void {
        // Figure out start/end bounds
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

        if (Object.keys(this.coreOpsToPlot).length == 0) {
            return;
        } // nothing to do

        for (const core of Object.keys(this.coreOpsToPlot)) {
            for (const input of Object.keys(this.coreOpsToPlot[core])) {
                for (const coreOp of this.coreOpsToPlot[core][input]) {
                    if (this.showTrisc) {
                        const unpackStart = isNumber(coreOp.unpackerFirstBlockDataAvailable)
                            ? coreOp.unpackerFirstBlockDataAvailable!
                            : Infinity;
                        const packEnd = isNumber(coreOp.packFinishLastOuterLoop) ? coreOp.packFinishLastOuterLoop! : 0;
                        this.startCycle = Math.min(
                            this.startCycle,
                            unpackStart,
                            coreOp.earliestWaitForIncomingTiles(),
                            coreOp.earliestWaitForFreeTiles(),
                            coreOp.earliestTriscStallOnDram(),
                        );
                        this.endCycle = Math.max(this.endCycle, packEnd, coreOp.latestTriscStallOnDram());
                    }
                    if (this.visProps.showAllDramReads) {
                        this.startCycle = Math.min(this.startCycle, coreOp.earliestRead());
                        this.endCycle = Math.max(this.endCycle, coreOp.latestRead());
                    }
                    if (this.visProps.showAllDramWrites) {
                        this.startCycle = Math.min(this.startCycle, coreOp.earliestWrite());
                        this.endCycle = Math.max(this.endCycle, coreOp.latestWrite());
                    }
                }
            }
        }

        for (const core of Object.keys(this.coreOpsToPlot)) {
            for (const input of Object.keys(this.coreOpsToPlot[core])) {
                for (const coreOp of this.coreOpsToPlot[core][input]) {
                    coreOp.setLeftBound(this.startCycle);
                    if (this.visProps.showModelNumbers && !coreOp.outOfMemory && isNumber(coreOp.modelCyclesProp)) {
                        this.endCycle = Math.max(
                            this.endCycle,
                            coreOp.bounds.low! - this.startCycle + coreOp.modelCyclesProp!,
                        );
                    }
                }
            }
        }
    }

    // Y coordinate of the text on the left (op names)
    bar_text_line_y = (_, index: number): number =>
        PerCoreD3Controller.MARGIN_SHIFT_DOWN + (index + 1) * this.BAR_REGION_HEIGHT - this.BAR_REGION_HEIGHT / 150;

    bar_fill = (coreOp: CoreOp): string => {
        // console.log(op.bounds)
        const input_index = this.allInputs.indexOf(coreOp.input);

        if (input_index >= 0) {
            return this.inputColors(input_index);
        }
        return 'green';
    };

    highlight(label: string): void {
        this.opNames.selectAll('text').attr('fill', (e: HostEvent | CoreOp[]) => {
            if (e instanceof HostEvent && e.name.includes(label)) {
                return '#00FFFF';
            }
            if (Array.isArray(e) && `${e[0].getCoreString()}-${e[0].input}`.includes(label)) {
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

            const mouseLocation = { x: d.pageX, y: d.pageY };
            d3.select(this).attr('fill', 'orange');
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

        for (const event of eventsToUpdate) {
            eventRegions
                .selectAll(`.host-event-${event.id}`)
                .attr('x', (box: Box) => this.currentXScale(box.low - this.startCycle))
                .attr('y', PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_TOP)
                .attr(
                    'width',
                    (box: Box) =>
                        this.currentXScale(box.high - this.startCycle) - this.currentXScale(box.low - this.startCycle),
                )
                .attr('height', event.barHeight)
                .style('cursor', 'pointer')
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
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + this.BAR_REGION_HEIGHT - padding;
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
                .attr('stroke', 'white')
                .attr('x1', 0)
                .attr('x2', this.FULL_W)
                .attr('y1', line_top)
                .attr('y2', line_top)
                .style('opacity', 0.3);
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
                PerCoreD3Controller.MARGIN_SHIFT_DOWN +
                index * this.BAR_REGION_HEIGHT +
                (1 / 2) * this.BAR_REGION_HEIGHT
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
            .attr('font-weight', 400)
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
            .attr('x2', PerCoreD3Controller.MARGIN_LEFT)
            .attr('y1', this.bar_text_line_y)
            .attr('y2', this.bar_text_line_y);
    }

    createDeviceBars(regions: any): void {
        const { opColors } = this;
        const { bar_fill } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            // per-thread-events-bar
            d3.select(this)
                .selectAll(`.pd-candle-bar-core-op-${coreOp.id}`)
                .data([coreOp])
                .enter()
                .append('rect')
                .attr('class', `pd-candle-bar-core-op-${coreOp.id} ` + `trisc-bar`)
                .attr('id', 'pd-candle-bar')
                .attr('stroke', 'white')
                .attr('stroke-width', 2)
                .attr('fill', bar_fill)
                .attr('cursor', 'pointer')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');

            // model bar
            d3.select(this)
                .selectAll(`.pd-candle-bar-model-core-op-${coreOp.id}`)
                .data([coreOp])
                .enter()
                .append('rect')
                .attr('class', `pd-candle-bar-model-core-op-${coreOp.id} ` + `trisc-bar`)
                .attr('id', 'pd-candle-bar-model')
                .attr('stroke', '#333')
                .attr('stroke-width', 1)
                .attr('fill', '#72deff')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');

            // model prop bar
            d3.select(this)
                .selectAll(`.pd-candle-bar-model-prop-core-op-${coreOp.id}`)
                .data([coreOp])
                .enter()
                .append('rect')
                .attr('class', `pd-candle-bar-model-prop-core-op-${coreOp.id} ` + `trisc-bar`)
                .attr('id', 'pd-candle-bar-model-prop')
                .attr('stroke', '#333')
                .attr('stroke-width', 1)
                .attr('fill', '#988bd0')
                .style('shape-rendering', 'optimizeSpeed')
                .style('vector-effect', 'non-scaling-stroke');
        });

        // wait for tile ,wait for free tile, trisc stall on dram boxes
        regions.each(function (this: any, coreOp: CoreOp) {
            if (coreOp.waitForIncomingTiles.size > 0 && coreOp.showWaitForTile) {
                let waitForIncomingTileId = 0;
                for (const [key, value] of coreOp.waitForIncomingTiles) {
                    d3.select(this)
                        .selectAll(`.core-op-id-${coreOp.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `core-op-id-${coreOp.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId} ` +
                                `per-core-rect-element`,
                        )
                        .attr('id', 'wait-for-incoming-tiles')
                        .attr('fill', opColors.wait_for_tile)
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                    waitForIncomingTileId += 1;
                }
            }

            if (coreOp.waitForFreeTiles.size > 0 && coreOp.showWaitForTile) {
                let waitForFreeTileId = 0;
                for (const [key, value] of coreOp.waitForFreeTiles) {
                    d3.select(this)
                        .selectAll(`.core-op-id-${coreOp.id}-wait-for-free-tiles-id-${waitForFreeTileId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `core-op-id-${coreOp.id}-wait-for-free-tiles-id-${waitForFreeTileId} ` +
                                `per-core-rect-element`,
                        )
                        .attr('id', 'wait-for-free-tiles')
                        .attr('fill', opColors.wait_for_free_tile)
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                    waitForFreeTileId += 1;
                }
            }

            if (coreOp.triscStallOnDramUnpacker.size > 0) {
                let triscStallOnDramUnpackerId = 0;
                for (const [key, value] of coreOp.triscStallOnDramUnpacker) {
                    d3.select(this)
                        .selectAll(`.coreOp-id-${coreOp.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `coreOp-id-${coreOp.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId} ` +
                                `per-core-rect-element`,
                        )
                        .attr('id', 'wait-for-free-tiles')
                        .attr('stroke', 'white')
                        .attr('stroke-width', 1)
                        .attr('fill', opColors.trisc_stall_on_dram_unpacker)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                    triscStallOnDramUnpackerId += 1;
                }
            }

            if (coreOp.triscStallOnDramPacker.size > 0) {
                let triscStallOnDramPackerId = 0;
                for (const [key, value] of coreOp.triscStallOnDramPacker) {
                    d3.select(this)
                        .selectAll(`.coreOp-id-${coreOp.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `coreOp-id-${coreOp.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId} ` +
                                `per-core-rect-element`,
                        )
                        .attr('id', 'wait-for-free-tiles')
                        .attr('stroke', 'white')
                        .attr('stroke-width', 1)
                        .attr('fill', opColors.trisc_stall_on_dram_packer)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                    triscStallOnDramPackerId += 1;
                }
            }
        });

        if (this.visProps.showAllDramReads) {
            regions.each(function (this: any, coreOp: CoreOp) {
                if (coreOp.dramReadIssued.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-read-issued-core-op-id-${coreOp.id}`)
                        .data(coreOp.dramReadIssued)
                        .enter()
                        .append('line')
                        .attr('class', `dram-read-issued-core-op-id-${coreOp.id} ` + `per-core-line-element`)
                        .attr('id', 'dram-read-issued')
                        .attr('stroke', opColors.dram_read_issued)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }

                if (coreOp.dramReadFlushed.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-read-flushed-core-op-id-${coreOp.id}`)
                        .data(coreOp.dramReadFlushed)
                        .enter()
                        .append('line')
                        .attr('class', `dram-read-flushed-core-op-id-${coreOp.id} ` + `per-core-line-element`)
                        .attr('id', 'dram-read-flushed')
                        .attr('stroke', opColors.dram_read_flushed)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            });
        }

        if (this.visProps.showAllDramWrites) {
            regions.each(function (this: any, coreOp: CoreOp) {
                if (coreOp.dramWriteSent.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-write-sent-core-op-id-${coreOp.id}`)
                        .data(coreOp.dramWriteSent)
                        .enter()
                        .append('line')
                        .attr('class', `dram-write-sent-core-op-id-${coreOp.id} ` + `per-core-line-element`)
                        .attr('id', 'dram-write-sent')
                        .attr('stroke', opColors.dram_write_sent)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }

                if (coreOp.dramWriteCleared.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-write-cleared-core-op-id-${coreOp.id}`)
                        .data(coreOp.dramWriteCleared)
                        .enter()
                        .append('line')
                        .attr('class', `dram-write-cleared-core-op-id-${coreOp.id} ` + `per-core-line-element`)
                        .attr('id', 'dram-write-cleared')
                        .attr('stroke', opColors.dram_write_tile_cleared)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            });
        }

        const { opBars } = this;
        regions.each(function (this: any, coreOp: CoreOp) {
            const core = coreOp.getCoreString();
            const { input } = coreOp;
            if (opBars.selectAll(`.separator-core-${core}-${input}`).nodes().length > 0) {
                return;
            }
            d3.select(this)
                .append('line')
                .attr('class', `separator-core-${core}-${input}`)
                .attr('id', 'plot-separator')
                .attr('stroke', 'white')
                .attr('stroke-width', 1)
                .style('opacity', 0.3);
        });
    }

    // first time draw of device op bars
    drawDeviceBars(): void {
        for (const core of Object.keys(this.coreOpsToPlot)) {
            for (const input of Object.keys(this.coreOpsToPlot[core])) {
                for (const coreOp of this.coreOpsToPlot[core][input]) {
                    this.opBars
                        .selectAll(`.g-core-op-${coreOp.id}`)
                        .data([coreOp])
                        .enter()
                        .append('g')
                        .attr('class', `g-core-ops g-core-op-${coreOp.id}`);
                }
            }
        }

        const regions = this.opBars.selectAll('.g-core-ops');
        this.createDeviceBars(regions);
    }

    updateTriscBars(opBars: any): void {
        const bar_low = (op: CoreOp): number =>
            !op.outOfMemory ? this.currentXScale(op.bounds.low! - this.startCycle) : 0;
        const bar_high = (op: CoreOp): number =>
            !op.outOfMemory ? this.currentXScale(op.bounds.high! - this.startCycle) : 0;
        // End of model and modelprop bars (These bars start at medLow of silicon data bars)
        const bar_model = (op: CoreOp): number =>
            !op.outOfMemory && isNumber(op.modelCycles)
                ? this.currentXScale(op.bounds.low! - this.startCycle + op.modelCycles!)
                : 0;
        const bar_modelProp = (op: CoreOp): number =>
            !op.outOfMemory && isNumber(op.modelCyclesProp)
                ? this.currentXScale(op.bounds.low! - this.startCycle + op.modelCyclesProp!)
                : 0;
        const bar_top = (op: CoreOp): number => {
            if (op.outOfMemory) {
                return 0;
            }
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            let sentHeight = 0;
            let clearedHeight = 0;
            if (op.dramWriteSent.length > 0 && this.visProps.showAllDramWrites) {
                sentHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites) {
                clearedHeight = PerCoreD3Controller.MARGIN_TOP + op.barHeight / 2;
            }

            const prevBarHeights = issuedHeight + flushedHeight + sentHeight + clearedHeight;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_modelTop = (op: CoreOp): number => (!op.outOfMemory ? bar_top(op) + op.barHeight : 0);
        const bar_modelPropTop = (op: CoreOp): number => (!op.outOfMemory ? bar_modelTop(op) + op.barHeight / 2 : 0);
        const capitalize = (s) => s && s[0].toUpperCase() + s.slice(1);
        const { d3Ref } = this;
        const { opNames } = this;
        const { bar_fill } = this;
        function handleMouseOver(this: SVGGraphicsElement, d, op: CoreOp) {
            const text: string[] = [];
            text.push(
                '<tr>',
                '<td id="Trisc">' + '<span style="color:black">' + 'Trisc Core Op' + '</span>' + '</td>',
                '<br>',
                `<td id="Op">` +
                    `<span style="color:black">` +
                    `Op: ` +
                    `</span>` +
                    `<span style="color:blue">${op.opName}</span>` +
                    `</td>`,
                '<br>',
                `<td id="GraphId">` +
                    `<span style="color:black">` +
                    `Graph Id: ` +
                    `</span>` +
                    `<span style="color:blue">${op.graphId}</span>` +
                    `</td>`,
                '<br>',
            );

            if (isNumber(op.deviceId)) {
                text.push(
                    `<td id="DeviceId">` +
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
                    `<td id="Epoch">` +
                        `<span style="color:black">` +
                        `Epoch: ` +
                        `</span>` +
                        `<span style="color:blue">${op.epoch}</span>` +
                        `</td>`,
                    '<br>',
                );
            }

            text.push(
                `<td id="Input">` +
                    `<span style="color:black">` +
                    `Input: ` +
                    `</span>` +
                    `<span style="color:blue">${op.input.split('-').pop()}</span>` +
                    `</td>`,
                '<br>',
                `<td id="Core">` +
                    `<span style="color:black">` +
                    `Core: ` +
                    `</span>` +
                    `<span style="color:blue">${op.getCoreString()}</span>` +
                    `</td>`,
                '<br>',
                `<td id="Unit">` +
                    `<span style="color:black">` +
                    `Unit: ` +
                    `</span>` +
                    `<span style="color:blue">${op.unit}</span>` +
                    `</td>`,
                '<br>',
                `<td id="EarliestStart">` +
                    `<span style="color:black">` +
                    `Start: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(
                        !op.outOfMemory ? op.bounds.low! - op.leftBound : 'N/A',
                    )}</span>` +
                    `</td>`,
                '<br>',
                `<td id="LatestEnd">` +
                    `<span style="color:black">` +
                    `End: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(
                        !op.outOfMemory ? op.bounds.high! - op.leftBound : 'N/A',
                    )}</span>` +
                    `</td>`,
                '<br>',
                `<td id="MaxDiff">` +
                    `<span style="color:black">` +
                    `Diff: ` +
                    `</span>` +
                    `<span style="color:blue">${d3.format(',')(
                        !op.outOfMemory ? op.bounds.high! - op.bounds.low! : 'N/A',
                    )}</span>` +
                    `</td>`,
            );

            // math utilization
            const mathUtil = twoDecimals(op.mathUtilization);
            text.push(
                '<br>',
                `<td id="MathUtil">` +
                    `<span style="color:black">` +
                    `Math-utilization: ` +
                    `</span>` +
                    `<span style="color:blue">${isNumber(mathUtil) ? `${mathUtil}%` : 'N/A'}</span>` +
                    `</td>`,
            );

            // unpack bw
            for (const ub of Object.keys(op.unpackBw)) {
                const unpackBw = twoDecimals(op.unpackBw[ub]);
                text.push(
                    '<br>',
                    `<td id="unpackBw">` +
                        `<span style="color:black">${capitalize(ub)}: ` +
                        `</span>` +
                        `<span style="color:blue">${isNumber(unpackBw) ? unpackBw : 'N/A'}</span>` +
                        `</td>`,
                );
            }

            // pack bw
            const packBw = twoDecimals(op.packBw);
            text.push(
                '<br>',
                `<td id="packBw">` +
                    `<span style="color:black">` +
                    `Pack-bw: ` +
                    `</span>` +
                    `<span style="color:blue">${isNumber(packBw) ? packBw : 'N/A'}</span>` +
                    `</td>`,
            );

            text.push('</tr>');

            const mouseLocation = { x: d.pageX, y: d.pageY };
            d3.select(this).attr('fill', 'orange');
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
                        !(e instanceof HostEvent) &&
                        [e[0].getCoreString(), e[0].input].join('-') == [op.getCoreString(), op.input].join('-'),
                )
                .attr('fill', '#00FFFF');
        }

        function handleMouseOut(this: SVGGraphicsElement, d, op: CoreOp) {
            d3.select(this).attr('fill', () => {
                return bar_fill(op);
            });
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
                        !(e instanceof HostEvent) &&
                        [e[0].getCoreString(), e[0].input].join('-') == [op.getCoreString(), op.input].join('-'),
                )
                .attr('fill', (e: CoreOp[]) => (e.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white'));
        }

        opBars
            .selectAll('#pd-candle-bar')
            .attr('x', bar_low)
            .attr('y', (op: CoreOp) => bar_top(op))
            .attr('width', (coreOp: CoreOp) => bar_high(coreOp) - bar_low(coreOp))
            .attr('height', (coreOp: CoreOp) => coreOp.barHeight)
            .on('mouseover', handleMouseOver)
            .on('mouseout', handleMouseOut);

        if (this.visProps.showModelNumbers) {
            opBars
                .selectAll('#pd-candle-bar-model')
                .attr('x', bar_low)
                .attr('y', (op: CoreOp) => (!op.outOfMemory && isNumber(op.modelCycles) ? bar_modelTop(op) : 0))
                .attr('width', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCycles) ? bar_model(coreOp) - bar_low(coreOp) : 0,
                )
                .attr('height', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCycles) ? coreOp.barHeight / 2 : 0,
                );

            opBars
                .selectAll('#pd-candle-bar-model-prop')
                .attr('x', bar_low)
                .attr('y', (op: CoreOp) => (!op.outOfMemory && isNumber(op.modelCyclesProp) ? bar_modelPropTop(op) : 0))
                .attr('width', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCyclesProp)
                        ? bar_modelProp(coreOp) - bar_low(coreOp)
                        : 0,
                )
                .attr('height', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCyclesProp) ? coreOp.barHeight / 2 : 0,
                );
        }
    }

    updateDramReadLines(opBars: any, coreOpsToUpdate: Record<string, Record<string, CoreOp[]>>): void {
        const { d3Ref } = this;
        const bar_top_issued = (): number => {
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_top_flushed = (coreOp: CoreOp): number => {
            let issuedHeight = 0;
            if (coreOp.dramReadIssued.length > 0) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + issuedHeight + PerCoreD3Controller.MARGIN_TOP;
        };

        function handleMouseOverIssued(this: SVGGraphicsElement, d, line: Line) {
            const text: string[] = [];
            // const index = dramReadIssued.nodes().indexOf(this);
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Dram Read Chunk Issued' + '</span>' + '</td>',
                '<br>',
                // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                // '<br>',
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
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);
        }

        function handleMouseOutIssued(this: SVGGraphicsElement) {
            d3.select(this).attr('stroke-width', 2);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        function handleMouseOverFlushed(this: SVGGraphicsElement, d, line: Line) {
            const text: string[] = [];
            // const index = dramReadFlushed.nodes().indexOf(this);
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Dram Read Tiles Flushed' + '</span>' + '</td>',
                '<br>',
                // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                // '<br>',
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
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);
        }

        function handleMouseOutFlushed(this: SVGGraphicsElement) {
            d3.select(this).attr('stroke-width', 2);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const input of Object.keys(coreOpsToUpdate[core])) {
                for (const coreOp of coreOpsToUpdate[core][input]) {
                    if (coreOp.dramReadIssued.length > 0) {
                        opBars
                            .selectAll(`.dram-read-issued-core-op-id-${coreOp.id}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('y1', bar_top_issued())
                            .attr('y2', bar_top_issued() + coreOp.barHeight / 2)
                            .on('mouseover', handleMouseOverIssued)
                            .on('mouseout', handleMouseOutIssued);
                    }
                    if (coreOp.dramReadFlushed.length > 0) {
                        opBars
                            .selectAll(`.dram-read-flushed-core-op-id-${coreOp.id}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('y1', bar_top_flushed(coreOp))
                            .attr('y2', bar_top_flushed(coreOp) + coreOp.barHeight / 2)
                            .on('mouseover', handleMouseOverFlushed)
                            .on('mouseout', handleMouseOutFlushed);
                    }
                }
            }
        }
    }

    updateDramWriteLines(opBars: any, coreOpsToUpdate: Record<string, Record<string, CoreOp[]>>): void {
        const { d3Ref } = this;

        const bar_top_sent = (coreOp: CoreOp): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            if (coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            const prevBarHeights = issuedHeight + flushedHeight;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        const bar_top_cleared = (coreOp: CoreOp): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            let sentHeight = 0;
            if (coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            if (coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            if (coreOp.dramWriteSent.length > 0) {
                sentHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2;
            }
            const prevBarHeights = issuedHeight + flushedHeight + sentHeight;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        function handleMouseOverSent(this: SVGGraphicsElement, d, line: Line) {
            const text: string[] = [];
            // const index = dramWriteSent.nodes().indexOf(this);
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Dram Write Tiles Sent' + '</span>' + '</td>',
                '<br>',
                // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                // '<br>',
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
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);
        }

        function handleMouseOutSent(this: SVGGraphicsElement) {
            d3.select(this).attr('stroke-width', 2);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        function handleMouseOverCleared(this: SVGGraphicsElement, d, line: Line) {
            const text: string[] = [];
            // const index = dramWriteCleared.nodes().indexOf(this);
            text.push(
                '<tr>',
                '<td id="field">' + '<span style="color:black">' + 'Dram Write Tiles Cleared' + '</span>' + '</td>',
                '<br>',
                // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                // '<br>',
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
            d3.select(d3Ref).select('.active-tooltip').style('left', `${loc.x}px`).style('top', `${loc.y}px`);
        }

        function handleMouseOutCleared(this: SVGGraphicsElement) {
            d3.select(this).attr('stroke-width', 2);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const input of Object.keys(coreOpsToUpdate[core])) {
                for (const coreOp of coreOpsToUpdate[core][input]) {
                    if (coreOp.dramWriteSent.length > 0) {
                        opBars
                            .selectAll(`.dram-write-sent-core-op-id-${coreOp.id}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('y1', bar_top_sent(coreOp))
                            .attr('y2', bar_top_sent(coreOp) + coreOp.barHeight / 2)
                            .on('mouseover', handleMouseOverSent)
                            .on('mouseout', handleMouseOutSent);
                    }
                    if (coreOp.dramWriteCleared.length > 0) {
                        opBars
                            .selectAll(`.dram-write-cleared-core-op-id-${coreOp.id}`)
                            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                            .attr('y1', bar_top_cleared(coreOp))
                            .attr('y2', bar_top_cleared(coreOp) + coreOp.barHeight / 2)
                            .on('mouseover', handleMouseOverCleared)
                            .on('mouseout', handleMouseOutCleared);
                    }
                }
            }
        }
    }

    updateWaitForTile(opBars: any, coreOpsToUpdate: Record<string, Record<string, CoreOp[]>>): void {
        const { d3Ref } = this;
        const { opColors } = this;
        const waitForTileRegex = /^wait-for-incoming-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
        const waitForFreeTileRegex = /^wait-for-free-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
        // Calculate y coordinate of wait for incoming tiles
        const bar_top_incoming = (coreOp: CoreOp, prevNumWaitForIncomingTiles: number): number => {
            const issuedHeight =
                coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const flushedHeight =
                coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const sentHeight =
                coreOp.dramWriteSent.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const clearedHeight =
                coreOp.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight;
            const prevModelHeights = this.visProps.showModelNumbers ? coreOp.barHeight : 0;
            const prevIncomingHeights =
                prevNumWaitForIncomingTiles * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevBarHeights =
                issuedHeight +
                flushedHeight +
                sentHeight +
                clearedHeight +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        // Calculate y coordinate of wait for free tiles
        const bar_top_free = (coreOp: CoreOp, prevNumWaitForFreeTiles: number): number => {
            const issuedHeight =
                coreOp.dramReadIssued.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const flushedHeight =
                coreOp.dramReadFlushed.length > 0 && this.visProps.showAllDramReads
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const sentHeight =
                coreOp.dramWriteSent.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const clearedHeight =
                coreOp.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites
                    ? PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight / 2
                    : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight;
            const prevModelHeights = this.visProps.showModelNumbers ? coreOp.barHeight : 0;
            const prevIncomingHeights =
                coreOp.waitForIncomingTiles.size * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevFreeHeights = prevNumWaitForFreeTiles * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevBarHeights =
                issuedHeight +
                flushedHeight +
                sentHeight +
                clearedHeight +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + prevBarHeights + PerCoreD3Controller.MARGIN_TOP;
        };

        function handleMouseOutIncoming(this: SVGGraphicsElement) {
            d3.select(this).attr('fill', opColors.wait_for_tile);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        function handleMouseOutFree(this: SVGGraphicsElement) {
            d3.select(this).attr('fill', opColors.wait_for_free_tile);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }

        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const input of Object.keys(coreOpsToUpdate[core])) {
                for (const coreOp of coreOpsToUpdate[core][input]) {
                    if (coreOp.waitForIncomingTiles.size > 0 && coreOp.showWaitForTile) {
                        const keys = [...coreOp.waitForIncomingTiles.keys()];
                        for (
                            let waitForIncomingTileId = 0;
                            waitForIncomingTileId < coreOp.waitForIncomingTiles.size;
                            waitForIncomingTileId++
                        ) {
                            const key = keys[waitForIncomingTileId];
                            function handleMouseOverIncoming(this: SVGGraphicsElement, d, rect: Rect) {
                                const text: string[] = [];
                                const id = waitForIncomingTile.nodes().indexOf(this);
                                const m = key.match(waitForTileRegex)!;
                                text.push(
                                    '<tr>',
                                    '<td id="field">' +
                                        '<span style="color:black">' +
                                        'Wait For Incoming Tiles' +
                                        '</span>' +
                                        '</td>',
                                    '<br>',
                                    `<td id="core">` +
                                        `<span style="color:black">` +
                                        `Core: ` +
                                        `</span>` +
                                        `<span style="color:blue">${coreOp.getCoreString()}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="index">` +
                                        `<span style="color:black">` +
                                        `ID: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(id)}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="outer-loop">` +
                                        `<span style="color:black">` +
                                        `Outer-loop: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[1]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="operand">` +
                                        `<span style="color:black">` +
                                        `Operand: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[2]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="num-tiles">` +
                                        `<span style="color:black">` +
                                        `Num-tiles: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[3]}</span>` +
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
                                        `<span style="color:blue">${d3.format(',')(
                                            rect.high - rect.leftBound,
                                        )}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="diff">` +
                                        `<span style="color:black">` +
                                        `Diff: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(rect.high - rect.low)}</span>` +
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
                            const waitForIncomingTile = opBars
                                .selectAll(
                                    `.core-op-id-${coreOp.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId}`,
                                )
                                .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                                .attr('y', bar_top_incoming(coreOp, waitForIncomingTileId))
                                .attr(
                                    'width',
                                    (rect: Rect) =>
                                        this.currentXScale(rect.high - this.startCycle) -
                                        this.currentXScale(rect.low - this.startCycle),
                                )
                                .attr('height', coreOp.barHeight)
                                .attr('stroke', 'white')
                                .attr('stroke-width', 1)
                                .attr('cursor', 'pointer')
                                .on('mouseover', handleMouseOverIncoming)
                                .on('mouseout', handleMouseOutIncoming);
                        }
                    }
                    if (coreOp.waitForFreeTiles.size > 0 && coreOp.showWaitForTile) {
                        const keys = [...coreOp.waitForFreeTiles.keys()];
                        for (
                            let waitForFreeTileId = 0;
                            waitForFreeTileId < coreOp.waitForFreeTiles.size;
                            waitForFreeTileId++
                        ) {
                            const key = keys[waitForFreeTileId];
                            function handleMouseOverFree(this: SVGGraphicsElement, d, rect: Rect) {
                                const text: string[] = [];
                                const id = waitForFreeTile.nodes().indexOf(this);
                                const m = key.match(waitForFreeTileRegex)!;
                                text.push(
                                    '<tr>',
                                    '<td id="field">' +
                                        '<span style="color:black">' +
                                        'Wait For Free Tiles' +
                                        '</span>' +
                                        '</td>',
                                    '<br>',
                                    `<td id="core">` +
                                        `<span style="color:black">` +
                                        `Core: ` +
                                        `</span>` +
                                        `<span style="color:blue">${coreOp.getCoreString()}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="index">` +
                                        `<span style="color:black">` +
                                        `ID: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(id)}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="outer-loop">` +
                                        `<span style="color:black">` +
                                        `Outer-loop: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[1]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="operand">` +
                                        `<span style="color:black">` +
                                        `Operand: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[2]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="num-tiles">` +
                                        `<span style="color:black">` +
                                        `Num-tiles: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[3]}</span>` +
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
                                        `<span style="color:blue">${d3.format(',')(
                                            rect.high - rect.leftBound,
                                        )}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="diff">` +
                                        `<span style="color:black">` +
                                        `Diff: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(rect.high - rect.low)}</span>` +
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
                            const waitForFreeTile = opBars
                                .selectAll(`.core-op-id-${coreOp.id}-wait-for-free-tiles-id-${waitForFreeTileId}`)
                                .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                                .attr('y', bar_top_free(coreOp, waitForFreeTileId))
                                .attr(
                                    'width',
                                    (rect: Rect) =>
                                        this.currentXScale(rect.high - this.startCycle) -
                                        this.currentXScale(rect.low - this.startCycle),
                                )
                                .attr('height', coreOp.barHeight)
                                .attr('stroke', 'white')
                                .attr('stroke-width', 1)
                                .attr('cursor', 'pointer')
                                .on('mouseover', handleMouseOverFree)
                                .on('mouseout', handleMouseOutFree);
                        }
                    }
                }
            }
        }
    }

    updateTriscStallOnDram(opBars: any, coreOpsToUpdate: Record<string, Record<string, CoreOp[]>>): void {
        const { d3Ref } = this;
        const { opColors } = this;
        const triscStallOnDramRegex = /^trisc-stall-on-dram-perf-dump-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
        const bar_top_unpacker = (coreOp: CoreOp, triscStallOnDramUnpackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !coreOp.outOfMemory ? coreOp.barHeight : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight;
            const prevIncomingHeights =
                coreOp.waitForIncomingTiles.size * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevFreeHeights = coreOp.waitForFreeTiles.size * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevTriscStallUnpackerHeights =
                triscStallOnDramUnpackerId * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            return (
                PerCoreD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                +prevFreeHeights +
                prevTriscStallUnpackerHeights +
                PerCoreD3Controller.MARGIN_TOP
            );
        };

        const bar_top_packer = (coreOp: CoreOp, triscStallOnDramPackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !coreOp.outOfMemory ? coreOp.barHeight : 0;
            const prevTriscHeight = PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight;
            const prevIncomingHeights =
                coreOp.waitForIncomingTiles.size * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevFreeHeights = coreOp.waitForFreeTiles.size * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevTriscStallUnpackerHeights =
                coreOp.triscStallOnDramUnpacker.size * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            const prevTriscStallPackerHeights =
                triscStallOnDramPackerId * (PerCoreD3Controller.MARGIN_TOP + coreOp.barHeight);
            return (
                PerCoreD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights +
                prevTriscStallUnpackerHeights +
                prevTriscStallPackerHeights +
                PerCoreD3Controller.MARGIN_TOP
            );
        };
        function handleMouseOutUnpacker(this: SVGGraphicsElement) {
            d3.select(this).attr('fill', opColors.trisc_stall_on_dram_unpacker);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }
        function handleMouseOutPacker(this: SVGGraphicsElement) {
            d3.select(this).attr('fill', opColors.trisc_stall_on_dram_packer);
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);
        }
        for (const core of Object.keys(coreOpsToUpdate)) {
            for (const input of Object.keys(coreOpsToUpdate[core])) {
                for (const coreOp of coreOpsToUpdate[core][input]) {
                    if (coreOp.triscStallOnDramUnpacker.size > 0) {
                        const keys = [...coreOp.triscStallOnDramUnpacker.keys()];
                        for (
                            let triscStallOnDramUnpackerId = 0;
                            triscStallOnDramUnpackerId < coreOp.triscStallOnDramUnpacker.size;
                            triscStallOnDramUnpackerId++
                        ) {
                            const key = keys[triscStallOnDramUnpackerId];
                            function handleMouseOverUnpacker(this: SVGGraphicsElement, d, rect: Rect) {
                                const text: string[] = [];
                                const index = triscStallOnDramUnpacker.nodes().indexOf(this);
                                const m = key.match(triscStallOnDramRegex)!;
                                text.push(
                                    '<tr>',
                                    '<td id="field">' +
                                        '<span style="color:black">' +
                                        'Unpacker Trisc Stall On Dram' +
                                        '</span>' +
                                        '</td>',
                                    '<br>',
                                    `<td id="core">` +
                                        `<span style="color:black">` +
                                        `Core: ` +
                                        `</span>` +
                                        `<span style="color:blue">${coreOp.loc.x}-${coreOp.loc.y}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="index">` +
                                        `<span style="color:black">` +
                                        `ID: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="outer-loop">` +
                                        `<span style="color:black">` +
                                        `Outer-loop: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[1]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="operand">` +
                                        `<span style="color:black">` +
                                        `Operand: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[2]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="num-tiles">` +
                                        `<span style="color:black">` +
                                        `Num-tiles: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[3]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="Unit">` +
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
                                        `<span style="color:blue">${d3.format(',')(
                                            rect.high - rect.leftBound,
                                        )}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="diff">` +
                                        `<span style="color:black">` +
                                        `Diff: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(rect.high - rect.low)}</span>` +
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
                            const triscStallOnDramUnpacker = opBars
                                .selectAll(
                                    `.coreOp-id-${coreOp.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId}`,
                                )
                                .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                                .attr('y', bar_top_unpacker(coreOp, triscStallOnDramUnpackerId))
                                .attr(
                                    'width',
                                    (rect: Rect) =>
                                        this.currentXScale(rect.high - this.startCycle) -
                                        this.currentXScale(rect.low - this.startCycle),
                                )
                                .attr('height', coreOp.barHeight)
                                .on('mouseover', handleMouseOverUnpacker)
                                .on('mouseout', handleMouseOutUnpacker);
                        }
                    }
                    if (coreOp.triscStallOnDramPacker.size > 0) {
                        const keys = [...coreOp.triscStallOnDramPacker.keys()];
                        for (
                            let triscStallOnDramPackerId = 0;
                            triscStallOnDramPackerId < coreOp.triscStallOnDramPacker.size;
                            triscStallOnDramPackerId++
                        ) {
                            const key = keys[triscStallOnDramPackerId];
                            function handleMouseOverPacker(this: SVGGraphicsElement, d, rect: Rect) {
                                const text: string[] = [];
                                const index = triscStallOnDramPacker.nodes().indexOf(this);
                                const m = key.match(triscStallOnDramRegex)!;
                                text.push(
                                    '<tr>',
                                    '<td id="field">' +
                                        '<span style="color:black">' +
                                        'Packer Trisc Stall On Dram' +
                                        '</span>' +
                                        '</td>',
                                    '<br>',
                                    `<td id="core">` +
                                        `<span style="color:black">` +
                                        `Core: ` +
                                        `</span>` +
                                        `<span style="color:blue">${coreOp.loc.x}-${coreOp.loc.y}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="index">` +
                                        `<span style="color:black">` +
                                        `ID: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(index)}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="outer-loop">` +
                                        `<span style="color:black">` +
                                        `Outer-loop: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[1]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="operand">` +
                                        `<span style="color:black">` +
                                        `Operand: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[2]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="num-tiles">` +
                                        `<span style="color:black">` +
                                        `Num-tiles: ` +
                                        `</span>` +
                                        `<span style="color:blue">${m[3]}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="Unit">` +
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
                                        `<span style="color:blue">${d3.format(',')(
                                            rect.high - rect.leftBound,
                                        )}</span>` +
                                        `</td>`,
                                    '<br>',
                                    `<td id="diff">` +
                                        `<span style="color:black">` +
                                        `Diff: ` +
                                        `</span>` +
                                        `<span style="color:blue">${d3.format(',')(rect.high - rect.low)}</span>` +
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
                            const triscStallOnDramPacker = opBars
                                .selectAll(
                                    `.coreOp-id-${coreOp.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId}`,
                                )
                                .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                                .attr('y', bar_top_packer(coreOp, triscStallOnDramPackerId))
                                .attr(
                                    'width',
                                    (rect: Rect) =>
                                        this.currentXScale(rect.high - this.startCycle) -
                                        this.currentXScale(rect.low - this.startCycle),
                                )
                                .attr('height', coreOp.barHeight)
                                .on('mouseover', handleMouseOverPacker)
                                .on('mouseout', handleMouseOutPacker);
                        }
                    }
                }
            }
        }
    }

    /** Recalculate coordinates of lines and bars */
    updateDeviceBars(regions: any, coreOpsToUpdate: Record<string, Record<string, CoreOp[]>>): void {
        if (this.visProps.showAllDramReads) {
            this.updateDramReadLines(regions, coreOpsToUpdate);
        }
        if (this.visProps.showAllDramWrites) {
            this.updateDramWriteLines(regions, coreOpsToUpdate);
        }
        if (this.showTrisc) {
            this.updateTriscBars(regions);
            this.updateWaitForTile(regions, coreOpsToUpdate);
            this.updateTriscStallOnDram(regions, coreOpsToUpdate);
        }
        this.updateDeviceBarSeparators();
        this.opBars
            .selectAll('.g-core-ops')
            .attr(
                'transform',
                (coreOp: CoreOp) =>
                    `translate(${0},${this.hostEventCoreOpIndexMap[coreOp.id] * this.BAR_REGION_HEIGHT})`,
            );
        // this.opBars.selectAll("rect").attr("stroke-width", this.currentXScale(this.startCycle + 3) - this.currentXScale(this.startCycle))
    }

    createDeviceOpNames(): void {
        const coreInputRegex = /^(\d+)-(\d+)-input-(\d+)$/;
        const coreInput: string[] = [];

        for (const core of this.cores) {
            for (const input of Object.keys(this.coreOpsToPlot[core])) {
                coreInput.push(`${core}-${input}`);
            }
        }

        coreInput.sort((a: string, b: string) => {
            const [a_y, a_x, a_in] = a.match(coreInputRegex)!.slice(1, 4);
            const [b_y, b_x, b_in] = b.match(coreInputRegex)!.slice(1, 4);

            if (a_y != b_y) {
                return parseInt(a_y) - parseInt(b_y);
            }
            if (a_x != b_x) {
                return parseInt(a_x) - parseInt(b_x);
            }
            return parseInt(a_in) - parseInt(b_in);
        });

        const coreOpsData: CoreOp[][] = [];
        for (const name of coreInput) {
            const [y, x, input] = name.match(coreInputRegex)!.slice(1, 4);
            coreOpsData.push(this.coreOpsToPlot[`${y}-${x}`][`input-${input}`]);
        }

        this.opNames
            .selectAll('.g-op-name')
            .data(coreOpsData)
            .enter()
            .append('g')
            .attr('class', 'g-op-name')
            .append('text')
            .attr('stroke', 'none')
            .text((coreOps: CoreOp[]) => {
                const text = `${coreOps[0].getCoreString()}-${coreOps[0].input}`;
                return coreOps.some((coreOp: CoreOp) => coreOp.outOfMemory) ? `${text}-out-of-memory` : text;
            });

        this.opNames
            .selectAll('.g-op-name')
            .append('line')
            .attr('class', 'text-separator-device')
            .attr('stroke', 'white')
            .attr('stroke-width', 1)
            .style('opacity', 0.1);
    }

    updateDeviceOpNames(): void {
        const textPaddingLeft = 10;
        const offsetY = this.hostEventsToPlot.length;
        // const updateCoreOp = (coreOps: CoreOp[]) => {
        //   for (const coreOp of coreOps) {
        //     coreOp.showWaitForTile = !coreOp.showWaitForTile;
        //   }
        //   this.calculateFlexableBounds();
        //   this.calculateDrawingParameters();
        //   this.draw();
        // };

        const textFill = (coreOps: CoreOp[]) => {
            return coreOps.some((coreOp: CoreOp) => coreOp.outOfMemory) ? 'red' : 'white';
        };

        const bar_text_y = (index: number): number => {
            return (
                PerCoreD3Controller.MARGIN_SHIFT_DOWN +
                (index + offsetY) * this.BAR_REGION_HEIGHT +
                (1 / 2) * this.BAR_REGION_HEIGHT
            );
        };
        const coreInputRegex = /(\d+)-(\d+)-input-(\d+)/;
        const coreInput: string[] = [];

        for (const core of this.cores) {
            for (const input of Object.keys(this.coreOpsToPlot[core])) {
                coreInput.push(`${core}-${input}`);
            }
        }

        // coreInput.sort((a: string, b: string) => {
        //   const [a_y, a_x, a_in] = a.match(coreInputRegex)!.slice(1, 4);
        //   const [b_y, b_x, b_in] = b.match(coreInputRegex)!.slice(1, 4);

        //   if (a_y != b_y) return parseInt(a_y) - parseInt(b_y);
        //   if (a_x != b_x) return parseInt(a_x) - parseInt(b_x);
        //   return parseInt(a_in) - parseInt(b_in);
        // });

        this.opNames
            .selectAll('.g-op-name')
            .selectAll('text')
            .attr('x', textPaddingLeft)
            .attr('y', function (this: SVGGraphicsElement, coreOps: CoreOp[]) {
                const textHeight = d3.select(this).node().getBBox().height;
                const y =
                    bar_text_y(coreInput.indexOf(`${coreOps[0].getCoreString()}-${coreOps[0].input}`)) + textHeight / 3;
                return y;
            })
            .attr('fill', textFill)
            .attr('font-size', () => {
                if (this.visProps.barRegionHeight > 30) {
                    return '0.85em';
                }
                if (this.visProps.barRegionHeight > 15) {
                    return '0.7em';
                }
                return '0.5em';
            });
        // .style("cursor", "pointer")
        // .on("click", function (d, coreOps: CoreOp[]) {
        //   updateCoreOp(coreOps);
        // })
        // .on("mouseover", function (this: SVGGraphicsElement) {
        //   d3.select(this)
        //     .attr("fill", "orange");
        // })
        // .on("mouseout", function (this: SVGGraphicsElement, d, coreOps: CoreOp[]) {
        //   d3.select(this)
        //     .attr("fill", textFill(coreOps));
        // });

        this.opNames
            .selectAll('.text-separator-device')
            .attr('x1', 0)
            .attr('x2', PerCoreD3Controller.MARGIN_LEFT)
            .attr('y1', (_, index: number) => this.bar_text_line_y(_, index + offsetY))
            .attr('y2', (_, index: number) => this.bar_text_line_y(_, index + offsetY));
    }

    updateDeviceBarSeparators(): void {
        const line_top = (): number => {
            const padding = this.BAR_REGION_HEIGHT / 150;
            return PerCoreD3Controller.MARGIN_SHIFT_DOWN + this.BAR_REGION_HEIGHT - padding;
        };
        for (let coreId = 0; coreId < this.cores.length; coreId++) {
            const core = this.cores[coreId];
            const inputs = Object.keys(this.coreOpsToPlot[core]);
            for (let inputId = 0; inputId < inputs.length; inputId++) {
                const input = inputs[inputId];
                this.plotSvg
                    .selectAll(`.separator-core-${core}-${input}`)
                    .attr('x1', 0)
                    .attr('x2', this.FULL_W)
                    .attr('y1', line_top())
                    .attr('y2', line_top());
            }
        }
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
            .attr('y2', this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN);

        this.plotSvg
            .selectAll('#timePoint')
            .attr('x', (indicator: Indicator) => this.currentXScale(indicator.value))
            .text((indicator: Indicator) => d3.format(',')(indicator.value)); // Cycle displayed at the top

        // const bubble = d3.select("#tooltipTimeDiff");

        // if (!bubble.empty()) width = bubble.node().getBoundingClientRect().width;
        if (!indicators.empty() && indicators.nodes().length == 2) {
            const leftWidth = window.innerWidth - this.visProps.width + PerCoreD3Controller.MARGIN_LEFT;
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
                    .attr('y1', PerCoreD3Controller.MARGIN_SHIFT_DOWN)
                    .attr('y2', height + PerCoreD3Controller.MARGIN_SHIFT_DOWN)
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
                    const leftWidth = window.innerWidth - visProps.width + PerCoreD3Controller.MARGIN_LEFT;
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
            .attr('y1', PerCoreD3Controller.MARGIN_SHIFT_DOWN)
            .attr('y2', this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN)
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
            const leftWidth = window.innerWidth - visProps.width + PerCoreD3Controller.MARGIN_LEFT;
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

    // note: region zoom and zoom should be updated
    updatePlotHeight(): void {
        // resize d3 ref (white box)
        d3.select(this.d3Ref)
            .style('min-height', `${this.visProps.height + PerCoreD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-height', `${this.visProps.height + PerCoreD3Controller.MARGIN_SHIFT_DOWN}px`);

        // resize svg
        this.svg
            .attr('height', this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM)
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM,
            ]);

        // resize plot svg
        this.plotSvg.attr(
            'height',
            this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM,
        );

        // reset x scale tick height
        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        // move x scale to the bottom of the plot
        this.xAxisg
            .attr('transform', `translate(${0},${this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        this.xAxisg.lower();

        this.plotSvg.select('.backgroundRect').attr('height', this.FULL_H);

        this.updateIndicators();
    }

    drawLegend(): void {
        const fieldNames: string[] = [];
        const fieldColors: string[] = [];
        const rectTextSpacing = 4;
        const rectWidth = 15;
        const rectHeight = 15;

        if (this.visProps.showAllDramReads) {
            fieldNames.push('Dram Read Chunk Read Issued', 'Dram Read Tiles Flushed');
            fieldColors.push(this.opColors.dram_read_issued, this.opColors.dram_read_flushed);
        }
        if (this.visProps.showAllDramWrites) {
            fieldNames.push('Dram Write Tiles Sent', 'Dram Write Tiles Cleared');
            fieldColors.push(this.opColors.dram_write_sent, this.opColors.dram_write_tile_cleared);
        }
        if (this.showTrisc) {
            fieldNames.push('Trisc');
            fieldColors.push('green');
        }
        fieldNames.push('Wait For Incoming Tiles', 'Wait For Free Tiles');
        fieldColors.push(this.opColors.wait_for_tile, this.opColors.wait_for_free_tile);

        // console.log(fieldNames)
        this.legend = this.svg
            .append('svg')
            .attr('class', 'legend-container')
            .attr('x', PerCoreD3Controller.MARGIN_LEFT / 2)
            .attr('y', 3 * 22)
            .attr('width', 200)
            .attr('height', fieldNames.length * 22)
            .style('cursor', 'pointer');

        this.legend
            .selectAll('.legend-element')
            .data(fieldNames)
            .enter()
            .append('g')
            .attr('class', 'legend-element')
            .attr('transform', (d, i) => {
                const horz = 0;
                const height = rectHeight + rectTextSpacing;
                // var horz = -2 * legendRectSize;
                const vert = i * height;
                return `translate(${horz},${vert})`;
            });

        d3.selectAll('.legend-element')
            .append('rect')
            .attr('width', rectWidth)
            .attr('height', rectHeight)
            .style('fill', (_: String, index: number) => fieldColors[index])
            .style('stroke', (_: String, index: number) => fieldColors[index]);

        d3.selectAll('.legend-element')
            .append('text')
            .attr('x', rectWidth + rectTextSpacing)
            .attr('y', rectHeight - rectTextSpacing)
            .attr('stroke', 'none')
            .attr('fill', 'white')
            .attr('font-size', '0.7em')
            .text((field: String) => field);

        const dragHandler = d3.drag().on('drag', function (this: any, d) {
            d3.select(this).attr('x', d.x).attr('y', d.y);
        });

        dragHandler(this.svg.selectAll('.legend-container'));
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
                        .attr('y1', PerCoreD3Controller.MARGIN_SHIFT_DOWN)
                        .attr('y2', FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN)
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

    updateTriscBarsAxisChange(): void {
        const bar_low = (op: CoreOp): number =>
            !op.outOfMemory ? this.currentXScale(op.bounds.low! - this.startCycle) : 0;
        const bar_high = (op: CoreOp): number =>
            !op.outOfMemory ? this.currentXScale(op.bounds.high! - this.startCycle) : 0;
        const bar_model = (op: CoreOp): number =>
            !op.outOfMemory && isNumber(op.modelCycles)
                ? this.currentXScale(op.bounds.low! - this.startCycle + op.modelCycles!)
                : 0;
        const bar_modelProp = (op: CoreOp): number =>
            !op.outOfMemory && isNumber(op.modelCyclesProp)
                ? this.currentXScale(op.bounds.low! - this.startCycle + op.modelCyclesProp!)
                : 0;

        this.opBars
            .selectAll('#pd-candle-bar')
            .attr('x', bar_low)
            .attr('width', (coreOp: CoreOp) => bar_high(coreOp) - bar_low(coreOp));

        if (this.visProps.showModelNumbers) {
            this.opBars
                .selectAll('#pd-candle-bar-model')
                .attr('x', bar_low)
                .attr('width', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCycles) ? bar_model(coreOp) - bar_low(coreOp) : 0,
                );

            this.opBars
                .selectAll('#pd-candle-bar-model-prop')
                .attr('x', bar_low)
                .attr('width', (coreOp: CoreOp) =>
                    !coreOp.outOfMemory && isNumber(coreOp.modelCyclesProp)
                        ? bar_modelProp(coreOp) - bar_low(coreOp)
                        : 0,
                );
        }
    }

    /** Update the plot on x axis change */
    updateDeviceBarsOnAxisChange(): void {
        this.updateTriscBarsAxisChange();

        // update all box elements, e.g. wait for tile
        this.opBars
            .selectAll('.per-core-rect-element')
            .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
            .attr(
                'width',
                (rect: Rect) =>
                    this.currentXScale(rect.high - this.startCycle) - this.currentXScale(rect.low - this.startCycle),
            );

        // update all line elements, e.g. dram read
        this.opBars
            .selectAll('.per-core-line-element')
            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle));

        this.updateIndicators();
    }

    redrawOnResize(): void {
        d3.select(this.d3Ref)
            .style('min-height', `${this.visProps.height + PerCoreD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-height', `${this.visProps.height + PerCoreD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-width', `${this.visProps.width + PerCoreD3Controller.MARGIN_RIGHT}px`);

        this.svg
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM)
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM,
            ]);

        this.plotSvg
            .attr('height', this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM)
            .attr('width', this.FULL_W);

        this.xScale.range([0, this.FULL_W]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg
            .attr('transform', `translate(${0},${this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        this.xAxisg.lower();

        this.plotSvg.select('.backgroundRect').attr('height', this.FULL_H).attr('width', this.FULL_W);

        this.plotSvg.selectAll('#plot-separator').attr('x2', this.FULL_W);

        this.updateDeviceBarsOnAxisChange();
        this.updateHostBars(this.opBars, this.hostEventsToPlot);

        this.zoomScale = 1;

        // update this.xScale in zoom
        this.zoom = d3
            .zoom()
            .scaleExtent([1, 17000])
            .on('zoom', (ev) => {
                this.zoomed(ev.transform);
            });

        this.zoom.translateExtent([
            [0, 0],
            [this.visProps.width, this.visProps.height],
        ]);
        this.plotSvg.call(this.zoom);

        this.resetZoom();
    }

    updateXScaleDomainAndApplyToBars(): void {
        this.xScale.domain([0, this.endCycle - this.startCycle]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg.call(this.xAxis);

        this.xAxisg.lower();

        this.updateHostBars(this.opBars, this.hostEventsToPlot);
        this.updateDeviceBarsOnAxisChange();

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
            .style('min-height', `${this.visProps.height + PerCoreD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-height', `${this.visProps.height + PerCoreD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-width', `${this.visProps.width + PerCoreD3Controller.MARGIN_RIGHT}px`);

        this.svg = d3
            .select(this.d3Ref)
            .append('svg')
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM)
            .attr('class', 'perf-dump-d3-per-core')
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM,
            ])
            .style('shape-rendering', 'optimizeSpeed');

        this.plotSvg = this.svg
            .append('svg')
            .attr('x', PerCoreD3Controller.MARGIN_LEFT)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN + PerCoreD3Controller.MARGIN_BOTTOM)
            .attr('class', 'perf-dump-d3-per-core-plot')
            .style('shape-rendering', 'optimizeSpeed');

        // Keep bars and lines from going out of the display box
        // this.svg.append("defs")
        //   .append("clipPath")
        //   .attr("id", "clipper")
        //   .append("rect")
        //   .attr("x", PerfDumpD3PerCore.MARGIN_LEFT)
        //   .attr("y", 0)
        //   .attr("width", this.FULL_W)
        //   .attr("height", this.FULL_H + PerfDumpD3PerCore.MARGIN_SHIFT_DOWN + PerfDumpD3PerCore.MARGIN_BOTTOM);

        this.xScale = d3
            .scaleLinear()
            .domain([0, this.endCycle - this.startCycle])
            .range([0, this.FULL_W]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg = this.plotSvg
            .append('g')
            .attr('class', 'x_axis')
            .attr('transform', `translate(${0},${this.FULL_H + PerCoreD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        // Darker background behind the bars
        this.plotSvg
            .append('rect')
            .attr('x', 0)
            .attr('y', PerCoreD3Controller.MARGIN_SHIFT_DOWN)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H)
            .attr('stroke', 'white')
            .attr('stroke-width', '1px')
            .attr('fill', 'rgba(16, 22, 26, 0.3)')
            .attr('class', 'backgroundRect'); // Shift the background down

        this.opNames = this.svg.append('g').attr('id', 'g-pd-opnames');
        this.opBars = this.plotSvg.append('g').attr('id', 'g-pd-opbars');
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
        this.drawDeviceBars();

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
        this.updateDeviceBars(this.opBars, this.coreOpsToPlot);
        this.createHostEventNames();
        this.updateHostEventNames();
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
        this.drawLegend();
        this.updateZoomRightClickDrag();
        this.updateIndicators();
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
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
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
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
    }

    // if the user deselected ops, remove the deslected ops from the plot
    reDrawOnOpDeselect(coreOpsToRemoveFromPlot: CoreOp[]): void {
        for (const coreOp of coreOpsToRemoveFromPlot) {
            this.opBars.selectAll(`.g-core-op-${coreOp.id}`).remove();
        }
        // reset the domain of x and apply the new scale to the bars
        this.updateXScaleDomainAndApplyToBars();
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
            const { input } = coreOp;
            if (regions.selectAll(`.separator-core-${core}-${input}`).nodes().length > 0) {
                return;
            }
            d3.select(this)
                .append('line')
                .attr('class', `separator-core-${core}-${input}`)
                .attr('id', 'plot-separator')
                .attr('stroke', 'white')
                .attr('stroke-width', 1)
                .style('opacity', 0.3);
        });
        // re draw horizontal lines so that they are the correct color
        this.updateDeviceBarSeparators();
        // move op names to correct rows
        this.opNames.selectAll('.g-op-name').remove();
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
    }

    reDrawOnOpSelect(newCoreOpsToPlot: Record<string, Record<string, CoreOp[]>>): void {
        let coreOps: CoreOp[] = [];
        for (const core of Object.keys(newCoreOpsToPlot)) {
            for (const input of Object.keys(newCoreOpsToPlot[core])) {
                coreOps = coreOps.concat(newCoreOpsToPlot[core][input]);
            }
        }
        const newOpRegions = this.opBars
            .selectAll('.placeholder-class')
            .data(coreOps)
            .enter()
            .append('g')
            .attr('class', (coreOp: CoreOp) => `g-core-ops g-core-op-${coreOp.id}`);

        // draw the newly selected ops
        this.createDeviceBars(newOpRegions);
        // update y coordinate and mouse over listeners for the newly selected ops
        this.updateDeviceBars(newOpRegions, newCoreOpsToPlot);

        // reset the domain of x and apply the new scale to the bars
        this.updateXScaleDomainAndApplyToBars();
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
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
    }

    getNumBars(): number {
        return this.svg.selectAll('*').nodes().length;
    }

    // Delete everything
    close(): void {
        console.log('Closing perf dump d3 per core');
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
        // eliminate zooming in the y direction
        transform.y = 0;
        // clamp x tranform to the width of the plot
        transform.x = Math.max(transform.x, (1 - transform.k) * this.FULL_W);
        const new_x_scale = transform.rescaleX(this.xScale);

        this.xAxisg.call(this.xAxis.scale(new_x_scale));

        this.currentXScale = new_x_scale;

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
        // this.opBars.selectAll("rect")
        //   .attr("stroke-width", 1 / transform.k);
    }

    // Zoom out
    resetZoom(): void {
        console.log('reset zoom');
        this.zoomed(d3.zoomIdentity);
        this.plotSvg.call(this.zoom.transform, d3.zoomIdentity);
    }

    getNumPlottedElements(): number {
        return this.hostEventsToPlot.length + Object.keys(this.opMap).length;
    }
}
