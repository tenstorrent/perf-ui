// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

import path from 'path';
import fs from 'fs';

import React, { Dispatch, Reducer } from 'react';
import { Tree, TreeNodeInfo } from '@blueprintjs/core';
import { Tooltip2 } from '@blueprintjs/popover2';
import { ItemPredicate } from '@blueprintjs/select';

import { isEqual } from 'lodash';
import { ConsoleLine } from 'renderer/spatial_gui/console_text';
import { MAX_PLOTTED_ELEMENTS } from './constants';

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [prop: string]: JsonObject | JsonPrimitive } | Array<JsonObject | JsonPrimitive>;

export interface IPerfResults {
    testname: string; // name of the test that the perf results folder belongs to
    path: string; // absolute path to the perf results folder
}

export const filterPerfResults: ItemPredicate<IPerfResults> = (query, folder, _index, exactMatch) => {
    const normalizedTitle = folder.path.toLowerCase();
    const normalizedQuery = query.toLowerCase();

    if (exactMatch) {
        return normalizedTitle === normalizedQuery;
    }
    // console.log("test name path: " + `${test.name}. ${test.path}`);
    return `${folder.path}. ${folder.testname}`.indexOf(query) >= 0;
};

export function testName(perfResultsPath: string): string {
    const name = perfResultsPath.split('/').slice(-2, -1)[0];
    return name;
}

export function perfResultsFromFolderPath(path: string): IPerfResults {
    const testname = testName(path);
    return { testname, path };
}

export const SPACE = '\u00a0';

export enum Frequency {
    DERIVED = 'Derived',
    AICLK = 'AICLK',
}

// right now only support cycles and nanoseconds
export enum Unit {
    CYCLES = 'Cycles',
    NS = 'Nanoseconds',
}

export function parseOpIdentifier(name: string): [string, number, number] {
    const regex = /^(\d+)-(\d+)-(\S+)$/;
    const m = name.match(regex);
    if (m === null) {
        // errors.push("Op {op_name} has invalid name pattern.");
        // console.error("Op name parsing error: ", name, m);
        return ['', 0, 0];
    }

    return [m[3], parseInt(m[1]), parseInt(m[2])];
}

export type NodePath = number[];

// extract 4 digit graph id from graph name
// note for now this strictly checks for 4 digits
// TODO: update when we decide graph id should not strictly be 4 digits
export function getGraphId(folder: string): string {
    const graphRegex = /^(\d+)(\S+)$/;
    const fourDigits = /^\d{4}$/;
    const graphName = folder.split('/').pop()!;
    // console.log("GRAPH NAME: ", graphName);
    const m = graphName.match(graphRegex);
    // console.log("M: ", m)
    if (m === null || !fourDigits.test(m[1])) {
        return '';
    }

    return m[1];
}

export function getEpochId(folder: string): string {
    const epochRegex = /^epoch_(\d+)$/;
    const epochFolder = folder.split('/').pop()!;
    const m = epochFolder.match(epochRegex);

    if (m === null) {
        return '';
    }

    return m[1];
}

export function lastElement<T>(arr: T[]): T | undefined {
    return Array.isArray(arr) ? arr.slice(-1)[0] : undefined;
}

// check if val is a number and is not NaN
export function isNumber(val: unknown): boolean {
    return typeof val === 'number' && !Number.isNaN(val);
}

export function isObject(val: unknown): boolean {
    if (val == null) {
        return false;
    }
    return typeof val === 'object' && typeof val !== 'function';
}

export function twoDecimals(n: number): number | undefined {
    if (!isNumber(n)) {
        return undefined;
    }
    const log10 = n ? Math.floor(Math.log10(n)) : 0;
    const div = log10 < 0 ? 10 ** (1 - log10) : 100;

    return Math.round(n * div) / div;
}

export function capitalize(s: string): string {
    return s && s[0].toUpperCase() + s.slice(1);
}

export function arrayDiff(a: unknown[], b: unknown[]): unknown[] {
    return a.filter((val) => !b.includes(val)).concat(b.filter((val) => !a.includes(val)));
}

export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export function isHostDirectory(folderPath: string): boolean {
    return lastElement(folderPath.split('/')) === 'host';
}

// Get all existing cores of selected folder combos data
export const getAllCores = (
    siliconData: Map<string, Record<string, any>> | null,
    folderPaths: string[][],
    ncriscMode: boolean,
): [string[], string[]] => {
    if (!siliconData || !ncriscMode) {
        return [[], []];
    }
    // retrieve core x-y from op name
    const getCore = (name: string): string => {
        const regex = /^(\d+)-(\d+)-(\S+)$/;
        const m = name.match(regex);
        if (m == null) {
            // errors.push("CoreOp {op_name} has invalid name pattern.");
            // console.error("CoreOp core parsing error: ", name, m);
            return '';
        }
        return `${m[1]}-${m[2]}`;
    };

    const coreOptions: string[] = ['Show All Cores'];

    for (const folderPath of folderPaths) {
        const dataKey = folderPath.join('/');
        if (isHostDirectory(dataKey)) {
            continue;
        }
        if (!siliconData.get(dataKey)) {
            console.error("COULD NOT FIND DATA KEY IN GET ALL CORES, SHOULDN'T HAPPEN");
            continue;
        }
        for (const opName of Object.keys(siliconData.get(dataKey)!)) {
            if (parseOpIdentifier(opName)[0] == '') {
                continue;
            }
            const core = getCore(opName);
            if (core.length > 0 && !coreOptions.includes(core)) {
                coreOptions.push(core);
            }
        }
    }

    coreOptions.sort(sortCores);
    return [coreOptions, coreOptions.slice(1)];
};

// sort by core coord (x-y), show all cores should be first element
export function sortCores(a: string, b: string): number {
    if (a == 'Show All Cores') {
        return -1;
    }
    if (b == 'Show All Cores') {
        return 1;
    }
    const [a_x, a_y] = a.split('-');
    const [b_x, b_y] = b.split('-');

    return a_x != b_x ? parseInt(a_x) - parseInt(b_x) : parseInt(a_y) - parseInt(b_y);
}

export function partialSort(arr: any[], start: number, end: number, sorter: (a: any, b: any) => number) {
    const preSorted = arr.slice(0, start);
    const postSorted = arr.slice(end);
    const sorted = arr.slice(start, end).sort(sorter);
    return preSorted.concat(sorted).concat(postSorted);
}

// dynamically locate tooltip on mouse over bars/lines so they don't go out of screen.
export function locateTooltip(
    mouseLocation: { x: number; y: number },
    tooltipWidth: number,
    tooltipHeight: number,
): { x: number; y: number } {
    const offset = 10;
    const bottomRight = {
        x: mouseLocation.x + offset,
        y: mouseLocation.y + offset,
    };
    const topLeft = {
        x: mouseLocation.x - tooltipWidth - offset,
        y: mouseLocation.y - tooltipHeight - offset,
    };
    const bottomLeft = {
        x: mouseLocation.x - tooltipWidth - offset,
        y: mouseLocation.y + offset,
    };
    const topRight = {
        x: mouseLocation.x + offset,
        y: mouseLocation.y - tooltipHeight - offset,
    };

    if (bottomRight.x + tooltipWidth < window.innerWidth && bottomRight.y + tooltipHeight < window.innerHeight) {
        return bottomRight;
    }
    if (topLeft.x > 0 && topLeft.y > 0) {
        return topLeft;
    }
    if (bottomLeft.x > 0 && bottomLeft.y + tooltipHeight < window.innerHeight) {
        return bottomLeft;
    }
    if (topRight.x + tooltipWidth < window.innerWidth && topRight.y > 0) {
        return topRight;
    }
    return bottomRight;
}

export function getOutputText(text: string): { content: string } {
    return { content: `> ${text}` };
}

export function getFrequencyText(
    deviceFrequencyMap: Map<string, Record<number, Record<string, number>>>,
    textColor = 'black',
    numColor = 'blue',
): React.ReactElement[] {
    // for each host data path, frequencyAlertMap contains all the device ids of
    // devices that have a big gap between calculated frequency and AICLK
    const threshold = 0.1;
    const frequencyAlertMap: Record<string, string[]> = {};
    if (deviceFrequencyMap != null) {
        for (const hostPath of deviceFrequencyMap!.keys()) {
            for (const deviceId of Object.keys(deviceFrequencyMap.get(hostPath)!)) {
                if (
                    Math.abs(
                        deviceFrequencyMap.get(hostPath)![deviceId].AICLK -
                            deviceFrequencyMap.get(hostPath)![deviceId]['derived-frequency'],
                    ) /
                        deviceFrequencyMap.get(hostPath)![deviceId].AICLK >=
                    threshold
                ) {
                    if (frequencyAlertMap[hostPath] !== undefined) {
                        frequencyAlertMap[hostPath].push(deviceId);
                    } else {
                        frequencyAlertMap[hostPath] = [deviceId];
                    }
                }
            }
        }
    }
    const text: Array<React.ReactElement> = [];
    for (const hostPath of Object.keys(frequencyAlertMap)) {
        const hostParentPath = `${hostPath.split('/').slice(0, -1).join('/')}/`;
        text.push(
            <p key={hostParentPath} style={{ color: textColor }}>
                {`For devices under ${hostParentPath}: `}
            </p>,
        );
        for (const deviceId of frequencyAlertMap[hostPath]) {
            text.push(
                <p key={hostParentPath + deviceId}>
                    <span style={{ color: textColor }}>
                        &#x2022; Device <span style={{ color: numColor }}>{deviceId}</span> has AICLK{' '}
                    </span>
                    <span style={{ color: numColor }}>
                        {`${twoDecimals(deviceFrequencyMap.get(hostPath)![deviceId].AICLK)} GHz`}
                    </span>
                    <span style={{ color: textColor }}> but derived frequency </span>
                    <span style={{ color: numColor }}>
                        {`${twoDecimals(deviceFrequencyMap.get(hostPath)![deviceId]['derived-frequency'])} GHz`}
                    </span>
                    <span style={{ color: textColor }}>.</span>
                </p>,
            );
        }
    }
    return Object.keys(frequencyAlertMap).length > 0 ? text : [];
}

// perf dump modes
export enum PerfDumpModes {
    DEFAULT,
    TRAINING,
    SINGLE_DIR,
    SINGLE_HOST_DIR,
    CUSTOM,
}

export const getJsonData = (filePath: string): Record<string, any> => {
    const rawData = fs.readFileSync(path.resolve(filePath));
    const jsonData = JSON.parse(rawData.toString());
    return jsonData || {};
};

/** Multi-rooted tree of strings, used to represent the subdirectory contents of a single directory
 * A single path traversal through the tree represents a valid filesystem path (relative to the containing directory)
 */
export interface MultiRootedRecordTree extends Record<string, unknown> {
    [key: string]: MultiRootedRecordTree;
}
/** A sequence of strings representing a single filesystem path */
export type FolderPathSequence = string[];

// Visual representation properties
export interface PerfDumpVisProps {
    width: number;
    height: number;
    unit: Unit;
    frequency: string;
    showModelNumbers: boolean; // show bars with expected numbers from the model
    showAllDramReads: boolean;
    showAllDramWrites: boolean;
    barRegionHeight: number;
    allInputs: string[];
    selectableInputs: string[];
    selectedFolderPaths: FolderPathSequence[];
    selectedInputs: string[];
    xyOrder: boolean;
}

// get all selectable inputs of selected folder combos data
export const getAllInputs = (
    siliconData: Map<string, Record<string, any>> | null,
    folderPaths: string[][],
): string[] => {
    if (!siliconData) {
        return [];
    }
    const inputRegex = /^input-(\d+)$/;
    const inputs: string[] = [];

    // loop through all selected folder combos
    for (const folderPath of folderPaths) {
        if (lastElement(folderPath) === 'host') {
            continue;
        }
        const dataKey = folderPath.join('/');
        if (!siliconData.has(dataKey)) {
            continue;
        }

        // loop through all ops in data, extract all inputs under per thread events
        for (const [opName, opData] of Object.entries(siliconData.get(dataKey)!)) {
            if (parseOpIdentifier(opName)[0] === '') {
                continue;
            }
            if (opData['per-thread-events']) {
                Object.keys(opData['per-thread-events']).forEach((input: string) => {
                    if (!inputs.includes(input) && inputRegex.test(input)) {
                        inputs.push(input);
                    }
                });
            }
        }
    }

    // sort inputs in ascending order
    inputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
    return inputs;
};

// Candlestick:   <-----[========]------->
//              low   medLow  medHigh  high
interface CandlestickBounds {
    low: number | undefined;
    medLow: number | undefined; // median
    medHigh: number | undefined;
    high: number | undefined;
}

// Box:   [========]
//       low      high
// for host events
export interface Box {
    low: number;
    high: number;
    eventName: string;
    name: string;
    fullName: string;
    process: string;
}

export interface Coord {
    x: number;
    y: number;
}

export class Line {
    value: number;

    // global earliest start that used to normalize the timestamps
    leftBound: number;

    deviceStartCycle: number;

    deviceStartNs: number;

    unitConversionMap: Map<string, (oldValue: number) => number>;

    // data structures that have time recorded in terms of each unit
    unitData: Map<string, number>;

    frequency: string;

    unit: string;

    constructor(timestamp: number, frequency = Frequency.DERIVED) {
        this.value = timestamp;
        this.leftBound = 0;

        this.unit = Unit.CYCLES;
        this.frequency = frequency;
        this.unitConversionMap = new Map<string, (oldValue: number) => number>();
        this.unitData = new Map<string, number>();
    }

    // op data recorded in cycles
    populateHostInfo(hostToDeviceMap: Record<string, number>): void {
        if (hostToDeviceMap == undefined) {
            // console.error("Line: undefined host to device map when populating host info.");
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
    }

    // create data structures to store data for each unit.
    populateUnitData(): void {
        for (const unit of this.unitConversionMap.keys()) {
            const converter = this.unitConversionMap.get(unit)!;
            this.unitData.set(unit, converter(this.value));
        }
    }

    switchToFrequency(frequency: string): void {
        if (!Object.values(Frequency).includes(frequency as Frequency)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }

        this.frequency = frequency;
        if (this.unit === Unit.NS) {
            this.switchToUnit(this.unit);
        }
    }

    switchToUnit(unit: string): void {
        if (!Object.values(Unit).includes(unit as Unit)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }
        const newVal = unit === Unit.CYCLES ? this.unitData.get(unit) : this.unitData.get(unit + this.frequency);
        if (!isNumber(newVal)) {
            // console.error(`Line: no conversion found for unit ${unit}.`);
            return;
        }

        this.value = newVal!;
        this.unit = unit;
    }
}

export class Rect {
    low: number;

    high: number;

    // global earliest start that used to normalize the timestamps
    leftBound: number;

    deviceStartCycle: number;

    deviceStartNs: number;

    unitConversionMap: Map<string, (oldValue: number) => number>;

    // data structures that have time recorded in terms of each unit
    unitData: Map<string, Record<string, number>>;

    frequency: string;

    unit: string;

    constructor(low: number, high: number, frequency = Frequency.DERIVED) {
        this.low = low;
        this.high = high;
        this.leftBound = 0;

        this.unit = Unit.CYCLES;
        this.frequency = frequency;
        this.unitConversionMap = new Map<string, (oldValue: number) => number>();
        this.unitData = new Map<string, Record<string, number>>();
    }

    // op data recorded in cycles
    populateHostInfo(hostToDeviceMap: Record<string, number>): void {
        if (hostToDeviceMap === undefined) {
            // console.error("Line: undefined host to device map when populating host info.");
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
    }

    // create data structures to store data for each unit.
    populateUnitData(): void {
        for (const unit of this.unitConversionMap.keys()) {
            const converter = this.unitConversionMap.get(unit)!;
            this.unitData.set(unit, {
                low: converter(this.low),
                high: converter(this.high),
            });
        }
    }

    switchToFrequency(frequency: string): void {
        if (!Object.values(Frequency).includes(frequency as Frequency)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }

        this.frequency = frequency;
        if (this.unit === Unit.NS) {
            this.switchToUnit(this.unit);
        }
    }

    switchToUnit(unit: string): void {
        if (!Object.values(Unit).includes(unit as Unit)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }
        const bounds = unit === Unit.CYCLES ? this.unitData.get(unit) : this.unitData.get(unit + this.frequency);
        if (!bounds) {
            // console.error(`Rect: no conversion found for unit ${unit}.`);
            return;
        }

        this.low = bounds.low;
        this.high = bounds.high;
        this.unit = unit;
    }
}

export class Indicator {
    value: number;

    xLocation: number;

    constructor(value: number, xLocation: number) {
        this.value = value;
        this.xLocation = xLocation;
    }

    updateValueOnUnitChange(newXScale: any): void {
        this.value = Math.round(newXScale.invert(this.xLocation));
    }
}

interface OpData {
    bounds: CandlestickBounds;
    modelCycles: number | undefined | undefined;
    modelCyclesProp: number | undefined;
}

/** Wrapper for op on all cores */
export class Op {
    fullName: string; // Full name in form (op_name-path-folderPath-in-input_index), should be unique among all ops

    name: string; // name in form op_name-graphId-in-input_index, should be unique among plotted ops, will be displayed at left of plot

    opName: string; // op_name only

    id: string;

    deviceId: number; // device that the ops ran on

    graphId: string;

    epoch: null | number;

    input: number;

    folderPath: string;

    coreOps: CoreOp[];

    modelCycles: number | undefined;

    modelCyclesProp: number | undefined;

    // global earliest start that used to normalize the timestamps
    leftBound: number;

    deviceStartCycle: number;

    deviceStartNs: number;

    mathUtilization: number;

    mathActivity: number[];

    bounds: CandlestickBounds; // calculated and cached bounds, scaled to start/end cycles for the full test

    visProps: PerfDumpVisProps;

    // clock cycle of events
    dramReadIssued: Line[];

    dramReadFlushed: Line[];

    dramWriteSent: Line[];

    dramWriteCleared: Line[];

    unitConversionMap: Map<string, (oldValue: number) => number>;

    // data structures that have time recorded in terms of each unit
    unitData: Map<string, OpData>;

    unit: string;

    frequency: string;

    barHeightRatio: number;

    barHeight: number;

    expanded: boolean; // Indicates if we should plot the coreOps of this op

    outOfMemory: boolean;

    feeders: string[];

    drainers: string[];

    // epoch should only have a value if graphId is N/A, note that epoch doesn't exist on spatial2
    // this is just temporary coverage for spatial1
    constructor(
        opName: string,
        folderPath: string,
        deviceId: number,
        graphId: string,
        input: number,
        visProps: PerfDumpVisProps,
        epoch: number | null,
        frequency = Frequency.DERIVED,
    ) {
        this.fullName = Op.getFullName(opName, folderPath, input);
        this.name = epoch === null ? `${opName}-${graphId}-in${input}` : `${opName}-ep${epoch}-in${input}`;
        this.opName = opName;
        this.folderPath = folderPath;
        this.deviceId = deviceId;
        this.graphId = graphId;
        this.input = input;
        this.leftBound = 0;
        this.visProps = visProps;
        this.coreOps = [];
        this.dramReadIssued = [];
        this.dramReadFlushed = [];
        this.dramWriteSent = [];
        this.dramWriteCleared = [];
        this.modelCycles = 0;
        this.modelCyclesProp = 0;
        this.expanded = false;
        this.outOfMemory = false;
        this.feeders = [];
        this.drainers = [];
        this.unit = Unit.CYCLES;
        this.frequency = frequency;
        this.unitConversionMap = new Map<string, (oldValue: number) => number>();
        this.unitData = new Map<string, OpData>();
    }

    getFeedersDrainers(): void {
        for (const coreOp of this.coreOps) {
            for (const feeder of coreOp.feeders) {
                if (!this.feeders.includes(feeder)) {
                    this.feeders.push(feeder);
                }
            }
            for (const drainer of coreOp.drainers) {
                if (!this.drainers.includes(drainer)) {
                    this.drainers.push(drainer);
                }
            }
        }
    }

    calculateMathUtilization(): void {
        const earliestTrisc = this.bounds.low;
        const latestTrisc = this.bounds.high;
        // console.log(`in calculate math utilization with earliest trisc ${earliestTrisc} and latest trisc ${latestTrisc}`);
        if (earliestTrisc === undefined || latestTrisc === undefined) {
            return;
        }
        let mathActivity: number[] = [];
        const allEqual = (arr: any[]) => arr.every((v) => v === arr[0]);
        for (const coreOp of this.coreOps) {
            // console.log(coreOp.mathActivity)
            if (coreOp.mathActivity.length > 0) {
                mathActivity = mathActivity.concat(coreOp.mathActivity);
                if (!allEqual(mathActivity)) {
                    return;
                }
            }
        }
        if (mathActivity.length > 0) {
            this.mathUtilization = mathActivity[0] / (latestTrisc - earliestTrisc);
        }
    }

    getNumRows(): number {
        let rows = 0;

        if (this.bounds.low !== undefined || this.bounds.high !== undefined) {
            rows += 1;
        } // may want to plot a placeholder if we have one of start/end, leave a row for it.

        if (this.visProps.showModelNumbers && this.bounds.low !== undefined && this.bounds.high !== undefined) {
            rows += 1; // plot both bars on different rows, but their heights add up to the height of one normal row
        }

        if (this.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
            rows += 1;
        }

        // if(this.dramReadFlushedCycles.length > 0 && this.visProps.showAllDramReads) rows += 1;

        if (this.dramWriteSent.length > 0 && this.visProps.showAllDramWrites) {
            rows += 1;
        }

        // if(this.dramWriteClearedCycles.length > 0 && this.visProps.showAllDramWrites) rows += 1;

        return rows;
    }

    getBarHeightRatio(): number {
        if (this.getNumRows() === 0) {
            return 0;
        }
        this.barHeightRatio = 2 / (3 * this.getNumRows());

        return this.barHeightRatio;
    }

    sortNcriscEvents(): void {
        const ascending = (a: Line, b: Line): number => {
            return a.value - b.value;
        };

        this.dramReadIssued.sort(ascending);
        this.dramReadFlushed.sort(ascending);
        this.dramWriteSent.sort(ascending);
        this.dramWriteCleared.sort(ascending);
    }

    earliestWaitForTile(): number {
        const minIncoming = this.coreOps.reduce((start: number, coreOp: CoreOp) => {
            const smallest = coreOp.earliestWaitForIncomingTiles();
            return smallest < start ? smallest : start;
        }, this.coreOps[0].earliestWaitForIncomingTiles());

        const minFree = this.coreOps.reduce((start: number, coreOp: CoreOp) => {
            const smallest = coreOp.earliestWaitForFreeTiles();
            return smallest < start ? smallest : start;
        }, this.coreOps[0].earliestWaitForFreeTiles());

        return Math.min(minIncoming, minFree);
    }

    earliestTriscStallOnDram(): number {
        return this.coreOps.reduce((start: number, coreOp: CoreOp) => {
            const smallest = coreOp.earliestTriscStallOnDram();
            return smallest < start ? smallest : start;
        }, this.coreOps[0].earliestTriscStallOnDram());
    }

    earliestTrisc(): number {
        if (this.coreOps.length === 0) {
            return Infinity;
        }

        return this.coreOps.reduce(
            (start: number, coreOp: CoreOp) =>
                isNumber(coreOp.unpackerFirstBlockDataAvailable) && coreOp.unpackerFirstBlockDataAvailable! < start
                    ? coreOp.unpackerFirstBlockDataAvailable!
                    : start,
            Infinity,
        );
    }

    latestTrisc(): number {
        if (this.coreOps.length === 0) {
            return 0;
        }
        return this.coreOps.reduce(
            (end: number, coreOp: CoreOp) =>
                isNumber(coreOp.packFinishLastOuterLoop) && coreOp.packFinishLastOuterLoop! > end
                    ? coreOp.packFinishLastOuterLoop!
                    : end,
            0,
        );
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
            latestRead = lastElement(this.dramReadIssued)!.value;
        }
        if (this.dramReadFlushed.length > 0) {
            latestRead = Math.max(latestRead, lastElement(this.dramReadFlushed)!.value);
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
            latestWrite = lastElement(this.dramWriteSent)!.value;
        }
        if (this.dramWriteCleared.length > 0) {
            latestWrite = Math.max(latestWrite, lastElement(this.dramWriteCleared)!.value);
        }

        return latestWrite;
    }

    /** Calculate candlestick bounds based on start/end cycles of the whole test */
    calculateBounds(): void {
        this.bounds = { low: 0, high: 0, medLow: 0, medHigh: 0 };

        // low / high are just lowest and highest values
        this.bounds.low = this.earliestTrisc();
        this.bounds.high = this.latestTrisc();

        if (this.bounds.low == Infinity) {
            this.outOfMemory = true;
            this.bounds.low = undefined;
        }

        if (this.bounds.high <= 0) {
            this.outOfMemory = true;
            this.bounds.high = undefined;
        }
        // medLow/High are median high/low values
        const median = (a: number[]) => {
            if (a.length === 0) {
                return 0;
            }
            if (a.length === 1) {
                return a[0];
            }
            const h = Math.floor(a.length / 2);
            return a.length % 2 === 0 ? a[h] : (a[h] + a[h + 1]) / 2;
        };

        const lows = this.coreOps
            .map((coreOp: CoreOp) => coreOp.unpackerFirstBlockDataAvailable!)
            .filter((num) => isNumber(num));
        lows.sort();
        const highs = this.coreOps
            .map((coreOp: CoreOp) => coreOp.packFinishLastOuterLoop!)
            .filter((num) => isNumber(num));
        highs.sort();

        this.bounds.medLow = median(lows);
        this.bounds.medHigh = median(highs);

        // console.log("OP BOUNDS: ", this.bounds)
    }

    setLeftBound(leftBound: number): void {
        this.leftBound = leftBound;
        this.dramReadIssued.forEach((line: Line) => {
            line.leftBound = leftBound;
        });
        this.dramReadFlushed.forEach((line: Line) => {
            line.leftBound = leftBound;
        });
        this.dramWriteSent.forEach((line: Line) => {
            line.leftBound = leftBound;
        });
        this.dramWriteCleared.forEach((line: Line) => {
            line.leftBound = leftBound;
        });
    }

    // op data recorded in cycles
    populateHostInfo(hostToDeviceMap: Record<string, number>): void {
        if (hostToDeviceMap == undefined) {
            // console.error("Op: undefined host to device map when populating host info.");
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
    }

    // create data structures to store data for each unit.
    populateUnitData(): void {
        for (const unit of this.unitConversionMap.keys()) {
            const converter = this.unitConversionMap.get(unit)!;
            const bounds = {
                low: isNumber(this.bounds.low) ? converter(this.bounds.low!) : undefined,
                medLow: isNumber(this.bounds.medLow) ? converter(this.bounds.medLow!) : undefined,
                medHigh: isNumber(this.bounds.medHigh) ? converter(this.bounds.medHigh!) : undefined,
                high: isNumber(this.bounds.high) ? converter(this.bounds.high!) : undefined,
            };

            const opData: OpData = {
                bounds,
                modelCycles: isNumber(this.modelCycles) ? converter(this.modelCycles!) : undefined,
                modelCyclesProp: isNumber(this.modelCycles) ? converter(this.modelCyclesProp!) : undefined,
            };

            this.unitData.set(unit, opData);

            this.dramReadIssued.forEach((line: Line) => line.populateUnitData());
            this.dramReadFlushed.forEach((line: Line) => line.populateUnitData());
            this.dramWriteSent.forEach((line: Line) => line.populateUnitData());
            this.dramWriteCleared.forEach((line: Line) => line.populateUnitData());
        }
    }

    switchToFrequency(frequency: string): void {
        if (!Object.values(Frequency).includes(frequency as Frequency)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }

        this.frequency = frequency;
        this.dramReadIssued.forEach((line: Line) => {
            line.switchToFrequency(frequency);
        });
        this.dramReadFlushed.forEach((line: Line) => {
            line.switchToFrequency(frequency);
        });
        this.dramWriteSent.forEach((line: Line) => {
            line.switchToFrequency(frequency);
        });
        this.dramWriteCleared.forEach((line: Line) => {
            line.switchToFrequency(frequency);
        });
        if (this.unit == Unit.NS) {
            const opData: OpData | undefined = this.unitData.get(this.unit + this.frequency);
            if (!opData) {
                return;
            }
            this.bounds = opData.bounds;
            this.modelCycles = opData.modelCycles;
            this.modelCyclesProp = opData.modelCyclesProp;
        }
    }

    switchToUnit(unit: string): void {
        if (!Object.values(Unit).includes(unit as Unit)) {
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }
        const opData: OpData | undefined =
            unit == Unit.CYCLES ? this.unitData.get(unit) : this.unitData.get(unit + this.frequency);
        if (!opData) {
            // console.error(`Op: no conversion found for unit ${unit}.`);
            return;
        }
        this.bounds = opData.bounds;
        this.modelCycles = opData.modelCycles;
        this.modelCyclesProp = opData.modelCyclesProp;
        this.dramReadIssued.forEach((line: Line) => {
            line.switchToUnit(unit);
        });
        this.dramReadFlushed.forEach((line: Line) => {
            line.switchToUnit(unit);
        });
        this.dramWriteSent.forEach((line: Line) => {
            line.switchToUnit(unit);
        });
        this.dramWriteCleared.forEach((line: Line) => {
            line.switchToUnit(unit);
        });

        // console.log("DRAM WRITE SENT: ", this.dramWriteSent)

        // console.log(`BOUNDS IN SWITCH TO UNIT ${unit}: `, this.bounds)
        this.unit = unit;
    }

    static getFullName(opName: string, folderPath: string, input: number): string {
        return `${opName}-path-${folderPath}-in${input}`;
    }
}

interface CoreOpData {
    bounds: CandlestickBounds;
    unpackerFirstBlockDataAvailable: number | undefined;
    packFinishLastOuterLoop: number | undefined;
    modelCycles: number | undefined;
    modelCyclesProp: number | undefined;
}

// Op on one particular core
export class CoreOp {
    parent: Op;

    loc: Coord;

    fullName: string;

    name: string;

    opName: string;

    id: string;

    deviceId: number;

    graphId: string;

    folderPath: string;

    epoch: null | number;

    input: number;

    bounds: CandlestickBounds; // calculated and cached bounds, scaled to start/end cycles for the full test

    // global earliest start that used to normalize the timestamps
    leftBound: number;

    deviceStartCycle: number;

    deviceStartNs: number;

    unpackerFirstBlockDataAvailable: number | undefined;

    packFinishLastOuterLoop: number | undefined;

    mathActivity: number[];

    mathUtilization: number;

    unpackBw: { [name: string]: number };

    packBw: number;

    modelCycles: number | undefined;

    modelCyclesProp: number | undefined;

    unit: string;

    frequency: string;

    xyOrder: boolean;

    unitConversionMap: Map<string, (oldValue: number) => number>;

    unitData: Map<string, CoreOpData>;

    feeders: string[];

    drainers: string[];

    waitForIncomingTiles: Map<string, Rect[]>;

    waitForFreeTiles: Map<string, Rect[]>;

    triscStallOnDramUnpacker: Map<string, Rect[]>;

    triscStallOnDramPacker: Map<string, Rect[]>;

    outOfMemory: boolean; // indicates whether unpackerFirstBlockDataAvailable or packFinishLastOuterLoop is missing

    barHeightRatio: number;

    barHeight: number;

    constructor(parent: Op, loc: Coord, id: string, frequency = Frequency.DERIVED, xyOrder = false) {
        this.parent = parent;
        this.loc = loc;
        this.deviceId = this.parent.deviceId;
        this.folderPath = this.parent.folderPath;
        this.graphId = this.parent.graphId;
        this.epoch = this.parent.epoch;
        this.input = this.parent.input;
        this.opName = this.parent.opName;
        this.xyOrder = xyOrder;
        this.name = `${this.getCoreString()}-${this.parent.name}`;
        this.fullName = `${this.name}-${this.folderPath}`;
        this.id = `${id}-in-${this.input}`;
        this.leftBound = 0;
        this.waitForIncomingTiles = new Map<string, Rect[]>();
        this.waitForFreeTiles = new Map<string, Rect[]>();
        this.triscStallOnDramUnpacker = new Map<string, Rect[]>();
        this.triscStallOnDramPacker = new Map<string, Rect[]>();
        this.unpackBw = {};
        this.outOfMemory = false;
        this.feeders = [];
        this.drainers = [];
        this.unit = Unit.CYCLES;
        this.frequency = frequency;

        // this.unitLookUp = new Map<string, number>();
        // // TODO: update
        // this.unitLookUp.set(Unit.NS, 1 / 0.01);
        // this.unitLookUp.set(Unit.CYCLES, 1);
        this.unitConversionMap = new Map<string, (oldValue: number) => number>();
        this.unitData = new Map<string, CoreOpData>();
    }

    getCoreString(): string {
        if (this.xyOrder) {
            return `${this.loc.y}-${this.loc.x}`;
        }
        return `${this.loc.x}-${this.loc.y}`;
    }

    setModelNumbers(): void {
        if (this.unpackerFirstBlockDataAvailable == undefined || this.packFinishLastOuterLoop == undefined) {
            return;
        }
        this.modelCycles = this.parent.modelCycles;
        this.modelCyclesProp = this.parent.modelCyclesProp;
    }

    getNumRows(): number {
        let rows = 0;
        // if there's one number that exists, plot one empty row or a red line to indicate out of memory
        if (this.unpackerFirstBlockDataAvailable != undefined || this.packFinishLastOuterLoop != undefined) {
            rows += 1;
        }
        if (
            this.parent.visProps.showModelNumbers &&
            (this.unpackerFirstBlockDataAvailable != undefined || this.packFinishLastOuterLoop != undefined)
        ) {
            rows += 1;
        }
        rows += this.triscStallOnDramUnpacker.size;
        rows += this.triscStallOnDramPacker.size;
        rows += this.waitForIncomingTiles.size;
        rows += this.waitForFreeTiles.size;
        return rows;
    }

    getBarHeightRatio(): number {
        if (this.getNumRows() == 0) {
            return 0;
        }
        this.barHeightRatio = 2 / (3 * this.getNumRows());

        return this.barHeightRatio;
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
            if (value.length > 0) {
                latest = Math.max(latest, lastElement(value)!.high);
            }
        }
        for (const value of this.triscStallOnDramPacker.values()) {
            if (value.length > 0) {
                latest = Math.max(latest, lastElement(value)!.high);
            }
        }
        return latest;
    }

    /** Calculate candlestick bounds based on start/end cycles of the whole test */
    calculateBounds(): void {
        if (this.unpackerFirstBlockDataAvailable == undefined || this.packFinishLastOuterLoop == undefined) {
            this.outOfMemory = true;
        }
        this.bounds = { low: 0, high: 0, medLow: 0, medHigh: 0 };

        // low / high are just lowest and highest values, no median for core op
        this.bounds.low = isNumber(this.unpackerFirstBlockDataAvailable)
            ? this.unpackerFirstBlockDataAvailable
            : undefined;
        this.bounds.high = isNumber(this.packFinishLastOuterLoop) ? this.packFinishLastOuterLoop : undefined;
        this.bounds.medLow = this.bounds.low;
        this.bounds.medHigh = this.bounds.high;
        // console.log("CORE OP BOUNDS: ", this.bounds)
    }

    setLeftBound(leftBound: number): void {
        this.leftBound = leftBound;
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

    // core op data recorded in cycles
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

    // create data structures to store data for each unit.
    populateUnitData(): void {
        for (const unit of this.unitConversionMap.keys()) {
            const converter = this.unitConversionMap.get(unit)!;

            const bounds = {
                low: isNumber(this.bounds.low) ? converter(this.bounds.low!) : undefined,
                medLow: isNumber(this.bounds.medLow) ? converter(this.bounds.medLow!) : undefined,
                medHigh: isNumber(this.bounds.medHigh) ? converter(this.bounds.medHigh!) : undefined,
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
                modelCyclesProp: isNumber(this.modelCyclesProp) ? converter(this.modelCyclesProp!) : undefined,
            };

            this.unitData.set(unit, opData);

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
            // console.error(`Target unit ${unit} does is not supported.`);
            return;
        }

        this.frequency = frequency;
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
            // console.error(`Can't switch to unit because target unit ${unit} does is not supported.`);
            return;
        }
        const opData: CoreOpData | undefined =
            unit == Unit.CYCLES ? this.unitData.get(unit) : this.unitData.get(unit + this.frequency);
        if (!opData) {
            // console.error(`Can't switch to unit because no conversion found for unit ${unit}.`);
            return;
        }
        this.bounds = opData.bounds;
        this.unpackerFirstBlockDataAvailable = opData.unpackerFirstBlockDataAvailable;
        this.packFinishLastOuterLoop = opData.packFinishLastOuterLoop;
        this.modelCycles = opData.modelCycles;
        this.modelCyclesProp = opData.modelCyclesProp;
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

        this.unit = unit;
    }
}

// interface HostEventData {
//   boxes: Box[];
// }

export class HostEvent {
    fullName: string; // full name in form host_event_name-folder_path

    eventName: string;

    name: string; // name of the host event

    id: string;

    folderPath: string;

    barHeightRatio: number;

    barHeight: number;

    process: string;

    // global earliest start that used to normalize the timestamps
    leftBound: number;

    boxes: Box[];

    earliestStart: number;

    latestEnd: number;

    unit: string;
    // unitLookUp: Map<string, number>;
    // unitData: Map<string, HostEventData>;

    constructor(eventName: string, eventData: Record<string, any>, folderPath: string, id: string) {
        this.process = eventData['process-id'];
        this.eventName = eventName;
        this.name = eventName;
        this.fullName = `${this.name}-${folderPath.split('/').join('-')}`;
        this.id = id;
        this.folderPath = folderPath;
        this.leftBound = 0;
        this.boxes = [];
        const startTimes = eventData.start;
        const endTimes = eventData.end;
        if (!Array.isArray(startTimes) || !Array.isArray(endTimes)) {
            return;
        }
        console.assert(
            startTimes.length == endTimes.length,
            `Start and end times should have the same length for host event ${this.name}.`,
        );
        for (let i = 0; i < startTimes.length && i < endTimes.length; i++) {
            const box: Box = {
                low: startTimes[i],
                high: endTimes[i],
                process: this.process,
                eventName: this.eventName,
                name: this.name,
                fullName: this.fullName,
            };
            console.assert(
                box.low <= box.high,
                `End time should not be earlier than start time for host event ${this.name}.`,
            );
            this.boxes.push(box);
        }
        this.unit = Unit.NS;
        this.calculateEarliestStart();
        this.calculateLatestEnd();
        // this.populateUnitData();
    }

    calculateEarliestStart(): void {
        let earliestStart = Infinity;
        for (const box of this.boxes) {
            earliestStart = Math.min(earliestStart, box.low);
        }
        this.earliestStart = earliestStart;
    }

    calculateLatestEnd(): void {
        let latestEnd = 0;
        for (const box of this.boxes) {
            latestEnd = Math.max(latestEnd, box.high);
        }
        this.latestEnd = latestEnd;
    }

    setBarHeight(barHeight: number): void {
        this.barHeight = (2 / 3) * barHeight;
    }

    getBarHeightRatio(): number {
        return 2 / 3;
    }

    // populateUnitData(): void {
    //   for (const unit of this.unitLookUp.keys()) {
    //     if (!Object.values(Unit).includes(unit as Unit)) {
    //       continue;
    //     }
    //     const conversionFactor = this.unitLookUp.get(unit);
    //     console.assert(isNumber(conversionFactor), `Conversion factor for unit ${unit} is not a number`);
    //     // initial unit of this.boxes is nanoseconds
    //     const eventData: HostEventData = {
    //       boxes: this.boxes.map((box: Box) => {
    //         return { low: box.low * conversionFactor, high: box.high * conversionFactor };
    //       })
    //     };

    //     this.unitData.set(unit, eventData);
    //   }

    // }

    // switchToUnit(unit: string): void {
    //   if (!Object.values(Unit).includes(unit as Unit)) {
    //     console.error(`Target unit ${unit} does is not supported.`);
    //     return;
    //   }
    //   const hostEventData: HostEventData = this.unitData.get(unit);
    //   if (!hostEventData) {
    //     console.error(`No conversion found for unit ${unit}.`);
    //     return;
    //   }
    //   this.boxes = hostEventData["boxes"];
    //   this.calculateEarliestStart();
    //   this.calculateLatestEnd();
    // }
}

export function processHostData(
    hostData: Map<string, Record<string, any>>,
    siliconData: Map<string, Record<string, any>> | null,
    hostPath: string,
    folderPathHostEventMap: Record<string, HostEvent[]>,
    folderPathHostToDeviceMap: Record<string, Record<number, Record<string, number>>>,
): void {
    const hostEvents: HostEvent[] = [];
    if (hostData == null || !hostData.has(hostPath)) {
        console.error(`hostPath ${hostPath} does not exist in hostData`);
        folderPathHostEventMap[hostPath] = [];
        folderPathHostToDeviceMap[hostPath] = {};
        return;
    }

    const populateHostToDeviceMap = (
        siliconData: Map<string, Record<string, any>>,
        hostData: Map<string, Record<string, any>>,
        hostPath: string,
        folderPathHostToDeviceMap: Record<string, Record<number, Record<string, number>>>,
    ): void => {
        const deviceRuntimeRegex = /^device-runtime-device-(\d+)(.*)$/;
        const deviceStartRegex = /^device-start-cycle-aligned-device-(\d+)(.*)$/;
        const deviceEndRegex = /^device-end-cycle-aligned-device-(\d+)(.*)$/;
        folderPathHostToDeviceMap[hostPath] = {};
        const folderPathHostData = hostData.get(hostPath);
        console.assert(folderPathHostData, 'Host path not found as a key in host data populate host to device map.');
        const deviceIds = [
            ...new Set(
                Object.keys(folderPathHostData!)
                    .filter(
                        (eventName: string) =>
                            deviceRuntimeRegex.test(eventName) ||
                            deviceStartRegex.test(eventName) ||
                            deviceEndRegex.test(eventName),
                    )
                    .map((eventName: string) => {
                        const match =
                            eventName.match(deviceRuntimeRegex) ||
                            eventName.match(deviceStartRegex) ||
                            eventName.match(deviceEndRegex);
                        return match![1];
                    }),
            ),
        ];

        const hostParentPath = hostPath.split('/').slice(0, -1).join('/');
        // if we have more than 1 device, we only have one device runtime event that indicates earliest start to latest end device
        // right now, using the earliest start time of device as an estimate of the start time for every device
        // TODO: update when we have run time for every device
        if (deviceIds.length > 1) {
            // let earliest_device = "";
            // let earliest_runtime = Infinity;
            // for (const deviceId of deviceIds){
            //     const runTime = folderPathHostData![Object.keys(folderPathHostData!).find(key => new RegExp("device-runtime-device-" + deviceId + ".*").test(key))!];
            //     let runtime_start = parseInt(runTime["start"]);
            //     if (runtime_start < earliest_runtime) {
            //       earliest_runtime = runtime_start;
            //       earliest_device = deviceId;
            //     }
            // }
            // console.assert(earliest_device != "")
            // console.assert(earliest_runtime != Infinity)

            // const deviceRuntime = Object.keys(folderPathHostData!).find((eventName: string) => RegExp("device-runtime-device-" + earliest_device + ".*").test(eventName));
            // const startNs = deviceRuntime ? parseInt(folderPathHostData![deviceRuntime]["start"]) : null;
            // console.log("Kd-device runtime =  ", deviceRuntime)
            // console.log("Kd-startNs =  ", startNs)
            // console.log("KD-earliest device =  ", earliest_device)
            for (const deviceId of deviceIds) {
                folderPathHostToDeviceMap[hostPath][deviceId] = {};
                for (const dataPath of siliconData.keys()) {
                    // find the aiclk (in Ghz) of each device that is correlated with host data under hostpath
                    if (
                        !dataPath.startsWith(hostParentPath) ||
                        siliconData.get(dataPath)!['per-epoch-events']['device-id'] != deviceId
                    ) {
                        continue;
                    }
                    const startCycle =
                        folderPathHostData![
                            Object.keys(folderPathHostData!).find((key) =>
                                new RegExp(`device-start-cycle-aligned-device-${deviceId}_.*`).test(key),
                            )!
                        ];
                    const runTime =
                        folderPathHostData![
                            Object.keys(folderPathHostData!).find((key) =>
                                new RegExp(`device-runtime-device-${deviceId}_.*`).test(key),
                            )!
                        ];
                    const endCycle =
                        folderPathHostData![
                            Object.keys(folderPathHostData!).find((key) =>
                                new RegExp(`device-end-cycle-aligned-device-${deviceId}_.*`).test(key),
                            )!
                        ];

                    const deviceRuntime = Object.keys(folderPathHostData!).find((eventName: string) =>
                        RegExp(`device-runtime-device-${deviceId}_.*`).test(eventName),
                    );
                    const startNs = deviceRuntime ? parseInt(folderPathHostData![deviceRuntime].start) : null;

                    const validStartCycle = startCycle != undefined && isNumber(parseInt(startCycle.value));
                    if (!isNumber(startNs) || !validStartCycle) {
                        break;
                    }
                    // temporary (before we dump actual data for each device in host)
                    // const clockFrequency = siliconData.get(dataPath)!["per-epoch-events"]["AICLK"] / 1000;
                    const AICLK = siliconData.get(dataPath)!['per-epoch-events'].AICLK / 1000;
                    console.assert(AICLK, 'Invalid AICLK');
                    const clockFrequency =
                        (parseInt(endCycle.value) - parseInt(startCycle.value)) /
                        (parseInt(runTime.end) - parseInt(runTime.start));
                    console.assert(clockFrequency, 'Invalid AICLK');
                    folderPathHostToDeviceMap[hostPath][deviceId]['clock-frequency'] = clockFrequency;
                    folderPathHostToDeviceMap[hostPath][deviceId].AICLK = AICLK;
                    console.log('derived freq for device ', deviceId, ' = ', clockFrequency, ' start ns = ', startNs);
                    folderPathHostToDeviceMap[hostPath][deviceId]['start-cycle'] = parseInt(startCycle.value);
                    folderPathHostToDeviceMap[hostPath][deviceId]['start-ns'] = startNs;
                    break;
                }
            }
        } else if (deviceIds.length == 1) {
            const deviceId = deviceIds[0];
            folderPathHostToDeviceMap[hostPath][deviceId] = {};
            for (const dataPath of siliconData.keys()) {
                // find the aiclk (in Ghz) of each device that is correlated with host data under hostpath
                if (
                    !dataPath.startsWith(hostParentPath) ||
                    siliconData.get(dataPath)!['per-epoch-events']['device-id'] != deviceId
                ) {
                    continue;
                }
                const runTime =
                    folderPathHostData![
                        Object.keys(folderPathHostData!).find((key) =>
                            new RegExp(`device-runtime-device-${deviceId}_.*`).test(key),
                        )!
                    ];
                const startCycle =
                    folderPathHostData![
                        Object.keys(folderPathHostData!).find((key) =>
                            new RegExp(`device-start-cycle-aligned-device-${deviceId}_.*`).test(key),
                        )!
                    ];
                const endCycle =
                    folderPathHostData![
                        Object.keys(folderPathHostData!).find((key) =>
                            new RegExp(`device-end-cycle-aligned-device-${deviceId}_.*`).test(key),
                        )!
                    ];
                const validRunTime = runTime && isNumber(parseInt(runTime.start)) && isNumber(parseInt(runTime.end));
                const validStartCycle = startCycle != undefined && isNumber(parseInt(startCycle.value));
                const validEndCycle = endCycle != undefined && isNumber(parseInt(endCycle.value));
                if (!validRunTime || !validStartCycle || !validEndCycle) {
                    break;
                }

                // calculate clock frequency in GHz (cycles/nanosecond)
                const AICLK = siliconData.get(dataPath)!['per-epoch-events'].AICLK / 1000;
                console.assert(AICLK, 'Invalid AICLK');
                const clockFrequency =
                    (parseInt(endCycle.value) - parseInt(startCycle.value)) /
                    (parseInt(runTime.end) - parseInt(runTime.start));
                folderPathHostToDeviceMap[hostPath][deviceId]['clock-frequency'] = clockFrequency;
                folderPathHostToDeviceMap[hostPath][deviceId].AICLK = AICLK;
                folderPathHostToDeviceMap[hostPath][deviceId]['start-cycle'] = parseInt(startCycle.value);
                folderPathHostToDeviceMap[hostPath][deviceId]['start-ns'] = parseInt(runTime.start);
                break;
            }
        }
    };

    siliconData != null && populateHostToDeviceMap(siliconData, hostData, hostPath, folderPathHostToDeviceMap);
    for (const [hostEventName, hostEventData] of Object.entries(hostData.get(hostPath)!)) {
        const hostEvent = new HostEvent(hostEventName, hostEventData, hostPath, hostEventData['event-id']);
        hostEvent.boxes.length > 0 && hostEvents.push(hostEvent);
    }
    folderPathHostEventMap[hostPath] = hostEvents;
}

export function processData(
    siliconData: Map<string, Record<string, any>> | null,
    modelData: Map<string, Record<string, any>> | null,
    hostData: Map<string, Record<string, any>> | null,
    allFolderPaths: string[],
    allInputs: string[],
    visProps: PerfDumpVisProps,
): [
    Record<string, Op>,
    Record<string, Op[]>,
    Record<string, Record<string, Op[]>>,
    Record<string, Record<string, Op>>,
    Record<string, HostEvent[]>,
    Record<string, Record<number, Record<string, number>>>,
] {
    // key: op full name, value: op with full name
    const opMap: Record<string, Op> = {};
    // contains all ops found
    const ops: Record<string, Op[]> = {};
    // folderPathOpMap[folderPath][op_name] contains an array of ops that have the same name but different inputs under folderpath
    // i.e. binary0-input0, binary0-input1, binary0-input2
    const folderPathOpMap: Record<string, Record<string, Op[]>> = {};
    // folderPathFirstInputOpMap[folderPath][op_name] contains the op with the earliest input
    // out of all ops that have name op_name under folderpath
    const folderPathFirstInputOpMap: Record<string, Record<string, Op>> = {};
    // folderPathHostEventMap[folderpath] contains an array of host events extracted from host jsons under folderpath.
    const folderPathHostEventMap: Record<string, HostEvent[]> = {};
    // folderPathHostToDeviceMap[folderPath][device-id] contains info about clock frequency, start cycles/ns for device
    // that has the same parent directory as the host folderPath
    const folderPathHostToDeviceMap: Record<string, Record<number, Record<string, number>>> = {};

    // folderPath is the directory path to the silicon/model data
    // console.log("ALL UNIQUE FOLDER PATHS: ", [...new Set(allFolderPaths)]);
    for (const folderPath of allFolderPaths) {
        if (isHostDirectory(folderPath)) {
            if (hostData == null) {
                console.error('Default-mode: host directory selected but null host data.');
                continue;
            }
            processHostData(hostData, siliconData, folderPath, folderPathHostEventMap, folderPathHostToDeviceMap);
            continue;
        }
        if (!siliconData) {
            console.error("Perf dump: Shouldn't get here, all paths should be host directories");
            continue;
        }
        // check if folderPath matches 4 digit graph id naming scheme
        let graphId = getGraphId(folderPath);
        let epochId = '';
        // if no graph id, then it should be an epoch folder
        if (graphId == '') {
            graphId = 'N/A';
            epochId = getEpochId(folderPath);
            if (epochId == '') {
                console.error("Couldn't find epoch ID or graph ID, shouldn't happen!");
                continue;
            }
        }
        // console.log("Folder Path Op Map Of Path: " + folderPath + "is: ", folderPathOpMap[folderPath])
        folderPathOpMap[folderPath] = {};
        ops[folderPath] = [];
        folderPathFirstInputOpMap[folderPath] = {};
        // TODO: add error checking if silicon data folder path is valid postprocess and if per-epoch-events device id exists
        const deviceId: number =
            siliconData.get(folderPath)!['per-epoch-events'] &&
            siliconData.get(folderPath)!['per-epoch-events']['device-id'];
        for (const [opIdentifier, opData] of Object.entries(siliconData.get(folderPath)!)) {
            const [opName, x, y] = parseOpIdentifier(opIdentifier);
            for (const input of allInputs) {
                // console.log("GRAPH ID: ", graphId);
                if (
                    opName === '' ||
                    !opData['per-thread-events'] ||
                    !opData['per-thread-events'][input] ||
                    opData['per-thread-events'][input] === 'N/A'
                ) {
                    continue;
                }
                // Find unique ops that may be performed on multiple cores
                // full_name should be a unique identifier of a specific op
                const inputNum = parseInt(input.split('-').pop()!);
                const fullName = Op.getFullName(opName, folderPath, inputNum);
                let parentOp = opMap[fullName];
                if (parentOp === undefined) {
                    parentOp = new Op(
                        opName,
                        folderPath,
                        deviceId,
                        graphId,
                        inputNum,
                        visProps,
                        isNumber(parseInt(epochId)) ? parseInt(epochId) : null,
                    );
                    opMap[parentOp.fullName] = parentOp;
                    ops[folderPath].push(parentOp);

                    if (Array.isArray(folderPathOpMap[folderPath][parentOp.opName])) {
                        folderPathOpMap[folderPath][parentOp.opName].push(parentOp);
                    } else {
                        folderPathOpMap[folderPath][parentOp.opName] = [parentOp];
                    }

                    // console.log("FOLDER PATH OP MAP IN PROCESS DATA: ", folderPathOpMap)
                }

                if (folderPathFirstInputOpMap[folderPath][parentOp.opName] === undefined) {
                    folderPathFirstInputOpMap[folderPath][parentOp.opName] = parentOp;
                } else if (folderPathFirstInputOpMap[folderPath][parentOp.opName] !== undefined) {
                    // if input 0 was undefined on core 1-1 but defined on core 1-2, we should update and record input 0 as the first input of the op.
                    if (parentOp.input < folderPathFirstInputOpMap[folderPath][parentOp.opName].input) {
                        folderPathFirstInputOpMap[folderPath][parentOp.opName] = parentOp;
                    }
                }

                const coreOp = new CoreOp(
                    parentOp,
                    { x, y },
                    opData['core-op-id'],
                    Frequency.DERIVED,
                    visProps.xyOrder,
                );

                // Start end time of green bars
                const perf = opData['per-thread-events'][input];
                const unpackerFirstBlockDataAvailable =
                    perf['unpacker-first-block-data-available'] || perf['unpack-first-block-data-available'];
                const packFinishLastOuterLoop = perf['pack-finish-last-outer-loop'] || perf['pack-end-outer-loop'];

                coreOp.unpackerFirstBlockDataAvailable = isNumber(unpackerFirstBlockDataAvailable)
                    ? unpackerFirstBlockDataAvailable
                    : undefined;
                coreOp.packFinishLastOuterLoop = isNumber(packFinishLastOuterLoop)
                    ? packFinishLastOuterLoop
                    : undefined;

                // math utilization
                const mathUtilization = perf['math-utilization-first-unpack-to-last-pack'];
                coreOp.mathUtilization = isNumber(mathUtilization) ? mathUtilization : undefined;
                // console.log("Math util in process data: ", coreOp.mathUtilization);

                // unpack bandwidth
                const unpackBwNames: string[] = [];
                for (const field of Object.keys(perf)) {
                    if (field.startsWith('unpack-') && field.endsWith('-bw')) {
                        unpackBwNames.push(field);
                    }
                }
                if (unpackBwNames.length > 0) {
                    unpackBwNames.sort((a: string, b: string) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]));
                    for (const ub of unpackBwNames) {
                        // assign numbers to coreOp unpack bandwidths
                        coreOp.unpackBw[ub] = isNumber(perf[ub]) ? perf[ub] : undefined;
                    }
                }

                // pack bandwidth
                coreOp.packBw = isNumber(perf['pack-bw']) ? perf['pack-bw'] : undefined;

                // math activity, used to calculate aggregated math utilization
                coreOp.mathActivity =
                    opData.T1 != undefined &&
                    opData.T1[''] != undefined &&
                    opData.T1['']['math-activity'] != 'N/A' &&
                    opData.T1['']['math-activity'];
                if (!Array.isArray(coreOp.mathActivity)) {
                    coreOp.mathActivity = [];
                }

                // wait for tile
                const dataT0 = !opData.T0 ? {} : opData.T0;
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
                        if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length == 0 || ends.length == 0) {
                            continue;
                        }
                        if (starts.length != ends.length) {
                            console.error(
                                `Number of start time stamps does not match number of end time stamps in ${field} of op ${opName}`,
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

                // wait for free tile
                const dataT2 = !opData.T2 ? {} : opData.T2;
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
                        if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length == 0 || ends.length == 0) {
                            continue;
                        }
                        if (starts.length !== ends.length) {
                            console.error(
                                `Number of start time stamps does not match number of end time stamps in ${field} of op ${opName}`,
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
                                `Number of start time stamps trisc stall does not match number of end time stamps in ${field} of op ${opName}`,
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
                                `Number of start time stamps trisc stall does not match number of end time stamps in ${field} of op ${opName}`,
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

                // // assuming all cores that run the same op have the same feeders and drainers, uncomment when we have valid cores to ops data.
                // const core = x + "-" + y;
                // if (coresToOpsData && coresToOpsData.get(epoch) && coresToOpsData.get(epoch)[core]) {
                //   // console.log("IN FEEDER DRAINER IF")
                //   const coreData = coresToOpsData.get(epoch)[core];
                //   let feeders = Array.isArray(coreData["input-nodes"]) ? coreData["input-nodes"] : [];
                //   feeders = feeders.map((op: string) => op + "-ep" + String(epoch) + "-in" + input.split("-").pop());
                //   let drainers = Array.isArray(coreData["output-nodes"]) ? coreData["output-nodes"] : [];
                //   drainers = drainers.map((op: string) => op + "-ep" + String(epoch) + "-in" + input.split("-").pop());
                //   coreOp.feeders = feeders;
                //   coreOp.drainers = drainers;
                // }

                parentOp.coreOps.push(coreOp);
                const ncriscData = opData.NCRISC;
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
                    const dramReadRegex = /^dram-read-stream-(\d+)-(\d+)$/;
                    const dramWriteSentRegex = /^dram-write-sent-stream-(\d+)-(\d+)$/;
                    const dramWriteClearedRegex = /^dram-write-tile-cleared-stream-(\d+)$/;
                    for (const field of fields) {
                        if (dramReadRegex.test(field)) {
                            if (Array.isArray(ncriscData[field]['chunk-read-issued'])) {
                                parentOp.dramReadIssued = parentOp.dramReadIssued.concat(
                                    ncriscData[field]['chunk-read-issued'].map((cycle: number) => new Line(cycle)),
                                );
                            }
                            if (Array.isArray(ncriscData[field]['tiles-flushed'])) {
                                parentOp.dramReadFlushed = parentOp.dramReadFlushed.concat(
                                    ncriscData[field]['tiles-flushed'].map((cycle: number) => new Line(cycle)),
                                );
                            }
                        } else if (dramWriteSentRegex.test(field) && Array.isArray(ncriscData[field].end)) {
                            parentOp.dramWriteSent = parentOp.dramWriteSent.concat(
                                ncriscData[field].end.map((cycle: number) => new Line(cycle)),
                            );
                        } else if (dramWriteClearedRegex.test(field) && Array.isArray(ncriscData[field].end)) {
                            parentOp.dramWriteCleared = parentOp.dramWriteCleared.concat(
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

    if (modelData) {
        for (const folderPath of allFolderPaths) {
            if (!modelData.has(folderPath)) {
                // runtime_table should exist in every device directory
                console.assert(
                    lastElement(folderPath.split('/')) == 'host',
                    `folder path ${folderPath} does not exist in model data.`,
                );
                continue;
            }
            for (const [op_name, model_data] of Object.entries(modelData.get(folderPath)!)) {
                for (const input of allInputs) {
                    const [opName, x, y] = parseOpIdentifier(op_name);
                    if (opName == '' || !model_data[input] || model_data[input] == 'N/A') {
                        continue;
                    }

                    const inputNum = parseInt(input.split('-').pop()!);
                    const fullName = Op.getFullName(opName, folderPath, inputNum);
                    const op = opMap[fullName];
                    if (op === undefined) {
                        console.error(`Could not find op with name ${fullName} in model data.`);
                        continue;
                    }
                    // TODO: what to display when model data out of memory
                    op.modelCycles = isNumber(model_data[input]['model-cycles-per-core'])
                        ? model_data[input]['model-cycles-per-core']
                        : undefined;
                    op.modelCyclesProp = isNumber(model_data[input]['model-prop-cycles-per-core'])
                        ? model_data[input]['model-prop-cycles-per-core']
                        : undefined;
                    // if (op.modelCycles == 0 && op.modelCyclesProp == 0) {
                    //   op.modelCycles = undefined;
                    //   op.modelCyclesProp = undefined;
                    // }
                }
            }
        }
    }

    // console.log("folderPathHostToDeviceMap: ", folderPathHostToDeviceMap);
    // console.log("EARLIEST INPUT OP MAP: ", folderPathFirstInputOpMap);
    // contains the parent paths of selected host directories.
    const hostPaths = Object.keys(folderPathHostToDeviceMap);
    for (const folderPath of Object.keys(ops)) {
        for (const op of ops[folderPath]) {
            // TODO: check device id exists
            op.id = `aggregated-op-${op.coreOps[0].id}`;
            const matchingHostPath = hostPaths.find((hostPath: string) => {
                const hostParentPath = hostPath.split('/').slice(0, -1).join('/');
                return op.folderPath.startsWith(hostParentPath);
            });

            matchingHostPath != undefined &&
                op.populateHostInfo(folderPathHostToDeviceMap[matchingHostPath][op.deviceId]);
            for (const coreOp of op.coreOps) {
                matchingHostPath != undefined &&
                    coreOp.populateHostInfo(folderPathHostToDeviceMap[matchingHostPath][op.deviceId]);
                coreOp.setModelNumbers();
                coreOp.calculateBounds();
                matchingHostPath != undefined && coreOp.populateUnitData();
            }
            op.sortNcriscEvents();
            op.calculateBounds();
            op.calculateMathUtilization();
            matchingHostPath != undefined && op.populateUnitData();
        }
    }

    // console.log("OPS: ", ops);
    // console.log("Finished process data");
    // console.log("Ops: ", ops);
    return [opMap, ops, folderPathOpMap, folderPathFirstInputOpMap, folderPathHostEventMap, folderPathHostToDeviceMap];
}

export const folderPathToNode = (nodes: TreeNodeInfo[], nodePath: NodePath): FolderPathSequence => {
    let node = nodes[nodePath[0]];
    const folderPath = [node.className!];
    const childNodePath = nodePath.slice(1);
    for (const id of childNodePath) {
        if (!node.childNodes) {
            throw Error('Attempted to access child nodes of a leaf node');
        }
        const nextNode = node.childNodes[id];
        if (!nextNode.className) {
            throw Error('Attempted to build a folder path from a node which does not have a folder name');
        }
        folderPath.push(nextNode.className);
        node = node.childNodes[id];
    }
    return folderPath;
};

const getNodeTooltipText = (node: TreeNodeInfo, selected: boolean): React.ReactElement => {
    const toolTipText1 = (
        <div>
            <b>{node.className}</b>
        </div>
    );
    let toolTipText2;
    // if (node.childNodes) toolTipText2 = <p><span className="folder-tree-click-text">Double-Click </span>to plot everything under me.</p>;
    if (!node.childNodes) {
        toolTipText2 = (
            <div>
                <p>
                    <span className="folder-tree-click-text">Click </span>to {selected ? 'remove from plot' : 'plot'}.
                </p>
            </div>
        );
    }
    return (
        <div>
            {toolTipText1}
            {toolTipText2}
        </div>
    );
};

export const toggleNodeSelectionState = (node: TreeNodeInfo): void => {
    if (node.isSelected === undefined) {
        throw Error('Attempted to toggle selection state of a node with undefined selection state');
    }
    node.isSelected = !node.isSelected;
    node.secondaryLabel = node.isSelected ? '✓' : null;

    const toolTipContent = getNodeTooltipText(node, node.isSelected);
    node.label = (
        <Tooltip2 openOnTargetFocus={false} content={toolTipContent} placement="right" intent="primary">
            {node.className}
        </Tooltip2>
    );
};

export type SelectionChangeHandler = (newSelections: FolderPathSequence[], shouldReSync?: boolean) => void;

export interface IVisContext {
    allFolderPaths: FolderPathSequence[];
    visProps: PerfDumpVisProps;
    numPlottedElements: number;
    onSelectionChange: SelectionChangeHandler;
    pushToConsole: Dispatch<ConsoleLine>;
}

export type VisContextMixin = { context: IVisContext };

export type TreeAction =
    | {
          type: 'SET_IS_EXPANDED';
          payload: { path: NodePath; isExpanded: boolean; node?: TreeNodeInfo };
      }
    | {
          type: 'SINGLE_SELECT';
          payload: { path: NodePath; node?: TreeNodeInfo };
      }
    | {
          type: 'SINGLE_DESELECT';
          payload: { path: NodePath; node?: TreeNodeInfo };
      }
    | {
          type: 'SELECT_RANGE';
          payload: { parentPath: NodePath; startIndex: number; endIndex: number };
      }
    | {
          type: 'RESET_SELECTION';
      }
    | {
          type: 'NODE_ONLY_SELECT';
          payload: { path: NodePath; node?: TreeNodeInfo };
      };

/** Returns a new version of the selected paths array, with the specified path removed.
 * Returns null if the path is the only selected item. */
export const removePathFromSelectedPaths = (
    selectedFolderPaths: FolderPathSequence[],
    folderPath: FolderPathSequence,
    onConsoleMessage: Dispatch<ConsoleLine>,
): FolderPathSequence[] | null => {
    if (selectedFolderPaths.length === 1) {
        onConsoleMessage({
            content: <p style={{ color: '#FFA000' }}>Cannot deselect the only selected item.</p>,
        });
        return null;
    }
    return selectedFolderPaths.filter((selectedPath) => !isEqual(selectedPath, folderPath));
};

export const filterNewPathSelections = (
    selectedFolderPaths: FolderPathSequence[],
    pathsToAdd: FolderPathSequence[],
    newSelectionLimit: number,
    onConsoleMessage: Dispatch<ConsoleLine>,
): FolderPathSequence[] => {
    const selectedPathsAsStrings = selectedFolderPaths.map((selectedPath) => selectedPath.join('/'));

    // Filter out paths that are already selected
    const filteredNewPaths = pathsToAdd.filter((newPath) => !selectedPathsAsStrings.includes(newPath.join('/')));

    if (filteredNewPaths.length > newSelectionLimit) {
        onConsoleMessage({ content: <p>&nbsp;</p> });
        onConsoleMessage({
            content: (
                <p className="console-warning">
                    Epoch selection error: given the number of currently plotted elements, you may not select more than{' '}
                    {newSelectionLimit} new epochs at once.
                    <br />
                    Only the first {newSelectionLimit} epochs will be selected.
                </p>
            ),
        });
        filteredNewPaths.splice(newSelectionLimit);
    }

    return filteredNewPaths;
};

/** Produces a state change to the Folder Tree when given a tree action (and associated context) */
export const folderTreeReducer: Reducer<TreeNodeInfo[], TreeAction & VisContextMixin> = (prevTreeState, action) => {
    let folderPath: FolderPathSequence;
    let changedNode: TreeNodeInfo;
    const consoleWarnLimitedOps = () => {
        action.context.pushToConsole({ content: <p>&nbsp;</p> });
        action.context.pushToConsole({
            content: (
                <p className="console-error">
                    Too many elements plotted. This is limited to {MAX_PLOTTED_ELEMENTS} to prevent lag.
                    <br />
                    Deselect some epochs or inputs before selecting more.
                </p>
            ),
        });
    };
    switch (action.type) {
        case 'SET_IS_EXPANDED':
            Tree.nodeFromPath(action.payload.path, prevTreeState).isExpanded = action.payload.isExpanded;
            // console.log("newExpansionState: ", newExpansionState);
            return [...prevTreeState];

        case 'SINGLE_SELECT': {
            if (action.context.numPlottedElements >= MAX_PLOTTED_ELEMENTS) {
                consoleWarnLimitedOps();
                return prevTreeState;
            }
            changedNode = action.payload.node || Tree.nodeFromPath(action.payload.path, prevTreeState);
            if (changedNode.isSelected) {
                console.warn('Folder node select: nothing to do -- node already selected. This indicates a state bug.');
                return prevTreeState;
            }
            folderPath = folderPathToNode(prevTreeState, action.payload.path);
            const newSelections = filterNewPathSelections(
                action.context.visProps.selectedFolderPaths,
                [folderPath],
                1,
                action.context.pushToConsole,
            );

            if (newSelections.length > 0) {
                toggleNodeSelectionState(changedNode); // Update new tree state
                // Side effect: update visProps
                action.context.onSelectionChange([...action.context.visProps.selectedFolderPaths, ...newSelections]);
            } else {
                console.warn('Selection of node resulted in no new selections');
            }
            return [...prevTreeState];
        }
        case 'SINGLE_DESELECT': {
            changedNode = action.payload.node || Tree.nodeFromPath(action.payload.path, prevTreeState);
            if (!changedNode.isSelected) {
                console.warn(
                    'Folder node deselect: nothing to do -- node is not selected. This indicates a state bug.',
                );
                return prevTreeState;
            }

            folderPath = folderPathToNode(prevTreeState, action.payload.path);
            const modifiedSelectedPaths = removePathFromSelectedPaths(
                action.context.visProps.selectedFolderPaths,
                folderPath,
                action.context.pushToConsole,
            );

            if (modifiedSelectedPaths !== null) {
                toggleNodeSelectionState(changedNode); // Update new tree state
                // Side effect: update visProps
                action.context.onSelectionChange(modifiedSelectedPaths);
            }
            return [...prevTreeState];
        }
        case 'NODE_ONLY_SELECT':
            changedNode = action.payload.node || Tree.nodeFromPath(action.payload.path, prevTreeState);
            if (changedNode.isSelected) {
                return prevTreeState;
            }
            console.log('#### SELECTING NODE (INITIAL): ', changedNode);
            toggleNodeSelectionState(changedNode); // Update new tree state
            return [...prevTreeState];

        case 'SELECT_RANGE': {
            if (action.context.numPlottedElements >= MAX_PLOTTED_ELEMENTS) {
                consoleWarnLimitedOps();
                return prevTreeState;
            }
            if (action.payload.endIndex < action.payload.startIndex) {
                console.error('Invalid range selection');
                return prevTreeState;
            }
            console.log('#### SELECTING RANGE: ', action.payload);
            const parentNode = Tree.nodeFromPath(action.payload.parentPath, prevTreeState);
            const candidateNodePaths = Array.from(
                Array(action.payload.endIndex - action.payload.startIndex + 1),
                (_, i) => action.payload.parentPath.concat([i + action.payload.startIndex]),
            );
            const candidateFolderPaths = candidateNodePaths.map((nodePath) =>
                folderPathToNode(prevTreeState, nodePath),
            );
            const newSelections = filterNewPathSelections(
                action.context.visProps.selectedFolderPaths,
                candidateFolderPaths,
                Math.max(
                    Math.floor(
                        (MAX_PLOTTED_ELEMENTS - action.context.numPlottedElements) /
                            (20 * action.context.visProps.selectedInputs.length),
                    ),
                    1,
                ),
                action.context.pushToConsole,
            );

            if (newSelections.length > 0) {
                const selectedEpochNames = newSelections.map((selectedFolderPath) => selectedFolderPath.at(-1));
                const selectedNodes = parentNode.childNodes!.slice(
                    action.payload.startIndex,
                    action.payload.endIndex + 1,
                );
                selectedNodes
                    .filter((node) => selectedEpochNames.includes(node.className))
                    .forEach((nodeCandidate) => {
                        if (!nodeCandidate.isSelected) {
                            toggleNodeSelectionState(nodeCandidate);
                        }
                    }); // Update new tree state
                // Side effect: update visProps
                action.context.onSelectionChange([...action.context.visProps.selectedFolderPaths, ...newSelections]);
            }

            return [...prevTreeState];
        }

        case 'RESET_SELECTION': {
            // Set visProps selection for host paths
            const hostDirectories = action.context.allFolderPaths.filter((fp) => isHostDirectory(fp.join('/')));

            // Recursively clear selection for all tree nodes
            prevTreeState.forEach(function clearSelection(treeNode: TreeNodeInfo) {
                if (treeNode.isSelected) {
                    toggleNodeSelectionState(treeNode);
                }
                if (treeNode.childNodes) {
                    treeNode.isExpanded = false;
                    treeNode.childNodes.forEach((node) => clearSelection(node));
                }
            });

            // Sync tree state with vis state
            action.context.onSelectionChange(hostDirectories, true);
            return [...prevTreeState];
        }

        default:
            return prevTreeState;
    }
};
