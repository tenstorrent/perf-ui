// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

/**
 * D3 portion (visualization) of the perf dump
 */

/* eslint no-unused-vars: [ "warn", { "argsIgnorePattern": "_" } ] */
/* eslint-disable @typescript-eslint/ban-types */
import * as d3 from 'd3';
import {
    Box,
    CoreOp,
    FolderPathSequence,
    Frequency,
    HostEvent,
    Indicator,
    Line,
    Op,
    PerfDumpVisProps,
    Rect,
    Unit,
    capitalize,
    getEpochId,
    getGraphId,
    isHostDirectory,
    isNumber,
    lastElement,
    locateTooltip,
    partialSort,
    processData,
    sortCores,
    twoDecimals,
} from '../perf_utils';
import PerfDumpFolderMap from '../folder_map';

export default class PerfDumpD3Controller {
    d3Ref: HTMLDivElement;

    visProps: PerfDumpVisProps;

    folderMap: PerfDumpFolderMap;

    data: Map<string, Record<string, any>> | null; // perf dump data

    modelData: Map<string, Record<string, any>> | null; // summary with model numbers

    hostData: Map<string, Record<string, any>> | null;

    coresToOpsData: Map<number, Object> | null; // info on feeders and drainers

    folderPaths: string[]; // folder combos we want to plot

    allFolderPaths: string[]; // All existing folder combos

    inputs: string[]; // This is the input index of interest when visualizing ops with multiple inputs

    allInputs: string[];

    allProcesses: string[];

    showTrisc: boolean;

    svg: any; // main SVG reference

    plotSvg: any; // SVG that contains the bars and x axis, child of main SVG reference

    zoom: any; // reference to zoom transformer

    zoomScale: number;

    unit: string;

    frequency: string;

    // references to various groups of elements that need to be moved, zoomed, etc.
    opBars: any; // "g" element holding op bars

    opNames: any; // "g" element holding op names

    xAxisg: any; // "g" element holding X axis

    legend: any; // "g" element holding legend

    // Ops
    folderPathOpMap: Record<string, Record<string, Op[]>>; // folderPathOpMap[folderPath][op_name] contains an array of all ops found under folder path that have the same op_name

    epochFirstInputOpMap: Record<string, Record<string, Op>>; // folderPathFirstInputOpMap[folderPath][op_name] contains the op with the earliest input out of all ops with the same op_name (ex.binary0) in folderPath.

    folderPathSortedOpMap: Record<string, Op[]>; // folderPathSortedOpMap[folderPath] contains a sorted array of ops that belong to folderPath. (sorted first by input-0 end time, then ops of the same name are grouped together, ordered by input id)

    ops: Record<string, Op[]>; // Contains all the ops organized by folder paths.

    hostEventOpIndexMap: Record<string, number>; // hostEventOpIndexMap[fullName] is the y-index of the host event/op.

    opsToPlot: Array<Op | CoreOp>; // Contains all ops, as well as coreOps of expanded Ops

    hostEventMap: Record<string, HostEvent[]>;

    hostEventsToPlot: HostEvent[];

    unitLookUp: Record<string, Record<string, Map<string, number>>>; // unitLookUp[folderPath][device-id][unit] contains datastructures with number in that unit

    opColors: Object; // Colors of ops

    inputColors: CallableFunction;

    hostEventColors: CallableFunction;

    showFeederDrainerOp: Op | undefined;

    // Bounds of the chart, based on what was found in the data
    startCycle: number;

    endCycle: number;

    fixedXscaleStart: number;

    fixedXscaleEnd: number;

    showHost: boolean;

    // origina and current X scale
    xScale: any;

    currentXScale: any;

    xAxis: any;

    // whether or not to display, toggled in graph mode
    display: boolean;

    // whether or not to set height of ref based on vis props, toggled in graph mode
    setRefMinHeight: boolean;

    // Draw parameters
    static MARGIN_TOP = 2; // margin at the top of the whole chart

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

    constructor(
        d3Ref: HTMLDivElement,
        visProps: PerfDumpVisProps,
        folderMap: PerfDumpFolderMap,
        data: Map<string, Record<string, any>> | null,
        modelData: Map<string, Record<string, any>> | null,
        hostData: Map<string, Record<string, any>> | null,
        display = true,
        setRefMinHeight = true,
    ) {
        console.log('Constructing new PerfDumpD3 instance');
        this.d3Ref = d3Ref;
        this.visProps = visProps;
        this.folderMap = folderMap;
        this.data = data;
        this.modelData = modelData;
        this.hostData = hostData;
        // TODO: may want to manually check all inputs in case of update inconsistency
        this.allInputs = [...visProps.allInputs];
        const inputRegex = /^input-(\d+)$/;

        this.allInputs.sort((a: string, b: string) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
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
        // to hide in graph dump
        this.display = display;
        this.setRefMinHeight = setRefMinHeight;

        // console.log("Data in perf dump d3 constructor: ", data);
        if (!this.checkInputs()) {
            this.close();
            return;
        }

        // Good colors: #66CDAA, #9ACD32, #00cc99, #40B5AD, #008cab
        this.inputColors = d3
            .scaleLinear<string>()
            .domain([0, Math.max(this.allInputs.length - 1, 1)])
            .range(['green', '#FFD700']);

        this.setFolderPaths();
        this.setInputs();
        this.setShowHost();
        let _;
        // Process data
        //
        // TODO: check if unit look up is correct, apply it to ops and events in process data
        [_, this.ops, this.folderPathOpMap, this.epochFirstInputOpMap, this.hostEventMap] = processData(
            this.data,
            this.modelData,
            this.hostData,
            this.allFolderPaths,
            this.allInputs,
            this.visProps,
        );
        this.setAllProcesses();
        // console.log("FOLDER PATH OP MAP: ", this.folderPathOpMap);
        this.hostEventColors = d3
            .scaleLinear<string, number, unknown>()
            .domain([0, Math.max(this.allProcesses.length - 1, 1)])
            .range(['#89CFF0', '#5D3FD3']);
        this.frequency = Frequency.DERIVED;
        this.unit = Unit.CYCLES;
        if (this.frequency !== this.visProps.frequency && this.hostData) {
            this.frequency = this.visProps.frequency;
            for (const folderPath of Object.keys(this.ops)) {
                for (const op of this.ops[folderPath]) {
                    op.switchToFrequency(this.frequency);
                    for (const coreOp of op.coreOps) {
                        coreOp.switchToFrequency(this.frequency);
                    }
                }
            }
        }

        if (this.unit !== this.visProps.unit && this.hostData) {
            this.unit = this.visProps.unit;
            for (const folderPath of Object.keys(this.ops)) {
                for (const op of this.ops[folderPath]) {
                    op.switchToUnit(this.unit);
                    for (const coreOp of op.coreOps) {
                        coreOp.switchToUnit(this.unit);
                    }
                }
            }
        }
        this.sortOpsAndHostEvents();
        this.filterOpsAndHostEvents();
        this.calculateFlexableBounds();
        //
        // Draw
        //
        // Calculate parameters
        this.calculateDrawingParameters();

        // First-time draw
        this.draw();

        this.updateXYOrder(this.visProps);
        // // Set variable parmeters
        // this.update(visProps);
    }

    setShowHost(): void {
        this.showHost = this.folderPaths.some((folderPath: string) => isHostDirectory(folderPath));
    }

    // Determine what folder combos to plot, sort by graph id.
    // TODO: may want to add the option of show all base folders, in that case, check in this function
    setFolderPaths(): void {
        const sortEpochs = (a: string, b: string): number => {
            return parseInt(getEpochId(a)) - parseInt(getEpochId(b));
        };
        // end of folder path should be 1 of 3 cases: four digit graph id followed by graph name, epoch_x, or host
        this.folderPaths = this.visProps.selectedFolderPaths
            .map((folderPath: string[]) => folderPath.join('/'))
            .filter(
                (folderPath: string) =>
                    getGraphId(folderPath) !== '' || getEpochId(folderPath) !== '' || isHostDirectory(folderPath),
            );
        this.folderPaths.sort((a: string, b: string) => {
            if (isHostDirectory(a) && isHostDirectory(b)) {
                return 0;
            }
            if (isHostDirectory(a)) {
                return -1;
            }
            if (isHostDirectory(b)) {
                return 1;
            }
            const aGraphId = getGraphId(a);
            const bGraphId = getGraphId(b);
            // if both folders don't have graph id
            if (aGraphId === '' && bGraphId === '') {
                return sortEpochs(a, b);
            }
            // if b has a graph id and a doesn't, b should go before a
            if (aGraphId === '' && bGraphId !== '') {
                return 1;
            }
            // if a has a graph id and b doesn't, a should go before b
            if (aGraphId !== '' && bGraphId === '') {
                return -1;
            }
            // if both a and b have a graph id, sort in ascending order
            return parseInt(aGraphId) - parseInt(bGraphId);
        });

        // all folder paths is all host folder paths + selected device folder paths
        // we need all host paths to be able to populate host info for according devices.
        this.allFolderPaths = this.folderMap.allFolderPaths
            .filter((folderPath: string[]) => lastElement(folderPath) === 'host')
            .map((folderPath: string[]) => folderPath.join('/'))
            .concat(this.folderPaths.filter((folderPath: string) => !isHostDirectory(folderPath)));
    }

    setInputs(): void {
        if (this.visProps.selectedInputs.includes('Show All Inputs')) {
            this.inputs = [...this.visProps.selectableInputs];
        } else {
            this.inputs = [...this.visProps.selectedInputs];
        }
        this.inputs.sort((a: string, b: string) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
    }

    // checkEpochs(): boolean {
    //   // console.log("All epochs in check epochs: ", this.allEpochs);
    //   // console.log("All selected epochs in visprops: ", this.visProps.selectedEpochs);
    //   for (const selectedEpoch of this.visProps.selectedEpochs) {
    //     if (selectedEpoch == "Show All Epochs") {
    //       continue;
    //     }
    //     if (!this.allEpochs.includes(selectedEpoch)) {
    //       return false;
    //     }
    //   }
    //   return true;
    // }

    checkInputs(): boolean {
        // console.log("All inputs in check inputs: ", this.allInputs);
        // console.log("All selected inputs in visprops: ", this.visProps.selectedInputs);
        for (const selectedInput of this.visProps.selectedInputs) {
            if (selectedInput == 'Show All Inputs') {
                continue;
            }
            if (!this.allInputs.includes(selectedInput)) {
                return false;
            }
        }
        return true;
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
        // Scale margin top based on bar height
        PerfDumpD3Controller.MARGIN_TOP = this.visProps.barRegionHeight / 80;
        // Calculate drawing parameters
        this.FULL_W = this.visProps.width - PerfDumpD3Controller.MARGIN_LEFT;
        // Space to plot one op, can increase if the plot looks too squished
        this.BAR_REGION_HEIGHT = this.visProps.barRegionHeight;
        const panelHeight = this.visProps.height - PerfDumpD3Controller.MARGIN_SHIFT_DOWN;
        // Try to fit all ops on the screen so we won't need to scroll
        this.FULL_H = Math.max(
            panelHeight,
            this.BAR_REGION_HEIGHT * (this.hostEventsToPlot.length + this.opsToPlot.length),
        );
        this.hostEventsToPlot.forEach(
            (event: HostEvent) => (event.barHeight = this.BAR_REGION_HEIGHT * event.getBarHeightRatio()),
        );
        this.opsToPlot.forEach((op: Op | CoreOp) => (op.barHeight = this.BAR_REGION_HEIGHT * op.getBarHeightRatio()));
    }

    // on selected inputs changes.
    updateInputs(newVisProps: PerfDumpVisProps): void {
        // const start = performance.now();
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
            const newOpsToPlot: Array<Op | CoreOp> = [];
            const newSelectedInputs = newInputs.filter((input: string) => !oldInputs.includes(input));
            for (const folderPath of this.folderPaths) {
                if (isHostDirectory(folderPath)) {
                    continue;
                }
                for (const op of this.folderPathSortedOpMap[folderPath]) {
                    if (newSelectedInputs.includes(`input-${op.input}`)) {
                        newOpsToPlot.push(op);
                        if (op.expanded) {
                            newOpsToPlot.push(...op.coreOps);
                        }
                    }
                }
            }
            if (!newOpsToPlot || newOpsToPlot.length === 0) {
                console.warn('Perf dump: null or empty new ops in new input selection.');
                return;
            }
            this.filterOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpSelect(newOpsToPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        } else if (newInputs.length < oldInputs.length) {
            const deSelectedInputs = oldInputs.filter((input: string) => !newInputs.includes(input));
            const opsToRemoveFromPlot: Array<Op | CoreOp> = [];
            for (const folderPath of this.folderPaths) {
                if (isHostDirectory(folderPath)) {
                    continue;
                }
                for (const op of this.folderPathSortedOpMap[folderPath]) {
                    if (deSelectedInputs.includes(`input-${op.input}`)) {
                        opsToRemoveFromPlot.push(op);
                        if (op.expanded) {
                            opsToRemoveFromPlot.push(...op.coreOps);
                        }
                    }
                }
            }
            if (!opsToRemoveFromPlot || opsToRemoveFromPlot.length === 0) {
                console.error('Perf dump: null or empty ops to remove in input deselection.');
            }
            this.filterOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpDeselect(opsToRemoveFromPlot);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        }
        // this.filterOpsAndHostEvents();
        // this.calculateFlexableBounds();
        // this.calculateDrawingParameters();
        // this.draw();
        // const end = performance.now();
        // console.log("TOOK: ", end - start);
    }

    updateFolderPaths(newVisProps: PerfDumpVisProps): void {
        // this.close();
        // const start = performance.now();
        const processDataOfNewFolderPath = (newFolderPath: string): Op[] => {
            const matchingHostPath = this.folderMap.allFolderPaths
                .filter((folderPath: string[]) => lastElement(folderPath) === 'host')
                .map((folderPath: string[]) => folderPath.join('/'))
                .find((folderPath: string) => newFolderPath.startsWith(folderPath.split('/').slice(0, -1).join('/')));

            // contains the new selected folder path, and the according host path so that we can process host data for the new device ops
            const selectedFolderPathAndHost = [newFolderPath];
            if (matchingHostPath !== undefined) {
                selectedFolderPathAndHost.push(matchingHostPath);
            }
            const [opMap, ops, folderPathOpMap, folderPathFirstInputOpMap] = processData(
                this.data,
                this.modelData,
                this.hostData,
                selectedFolderPathAndHost,
                this.allInputs,
                this.visProps,
            );
            const folderPathSortedOpMap: Record<string, Op[]> = {};
            let sortedOps: Op[] = [];
            // extract only ops that have the earliest input among ops that have the same name
            const earliestInputOps = Object.values(folderPathFirstInputOpMap[newFolderPath]);
            earliestInputOps.sort((a: Op, b: Op) => a.latestTrisc() - b.latestTrisc());

            // contains the names of ops which were sorted by the endtime of their first input id.
            const orderedOpNames = earliestInputOps.map((op: Op) => op.opName);

            // loop through ordered op names, extract all ops with that op name in this epoch and sort those ops by input id.
            for (const opName of orderedOpNames) {
                const allInputOps = folderPathOpMap[newFolderPath][opName];
                console.assert(allInputOps !== undefined, 'allInputsOps undefined in sort ops of perf dump d3');
                allInputOps.sort((a: Op, b: Op) => a.input - b.input);
                sortedOps = sortedOps.concat(allInputOps);
            }
            folderPathSortedOpMap[newFolderPath] = sortedOps;

            for (const op of ops[newFolderPath]) {
                // default unit for these new ops is cycles, if the current user-selected unit is ns, switch these ops to use ns numbers.
                if (this.unit !== Unit.CYCLES) {
                    op.switchToUnit(this.unit);
                    op.coreOps.forEach((coreOp: CoreOp) => coreOp.switchToUnit(this.unit));
                }
                // default frequency for these new ops is derived, if the current user-selected frequency is AICLK, switch these ops to use AICLK.
                if (this.frequency !== Frequency.DERIVED) {
                    op.switchToFrequency(this.frequency);
                    op.coreOps.forEach((coreOp: CoreOp) => coreOp.switchToFrequency(this.frequency));
                }
                op.coreOps.sort((c1: CoreOp, c2: CoreOp) => sortCores(c1.getCoreString(), c2.getCoreString()));
            }
            this.ops = { ...this.ops, ...ops };
            this.folderPathOpMap = { ...this.folderPathOpMap, ...folderPathOpMap };
            this.epochFirstInputOpMap = {
                ...this.epochFirstInputOpMap,
                ...folderPathFirstInputOpMap,
            };
            this.folderPathSortedOpMap = {
                ...this.folderPathSortedOpMap,
                ...folderPathSortedOpMap,
            };
            return this.ops[newFolderPath];
        };

        const removeDataOfFolderPath = (folderPath: string): Op[] => {
            const deletedOps = this.ops[folderPath];
            delete this.ops[folderPath];
            delete this.folderPathOpMap[folderPath];
            delete this.epochFirstInputOpMap[folderPath];
            delete this.folderPathSortedOpMap[folderPath];
            return deletedOps;
        };

        const oldFolderPaths = this.visProps.selectedFolderPaths.map((folderPath: FolderPathSequence) =>
            folderPath.join('/'),
        );
        const newFolderPaths = newVisProps.selectedFolderPaths.map((folderPath: FolderPathSequence) =>
            folderPath.join('/'),
        );
        const domain = this.currentXScale.domain();
        const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
        this.plotSvg.selectAll('#cycleIndicator').remove();
        d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
        this.plotSvg.selectAll('#timePoint').remove();
        this.visProps = newVisProps;
        this.setFolderPaths();
        this.setInputs();
        const newPathsSet = new Set(newFolderPaths);
        const oldPathsSet = new Set(oldFolderPaths);
        const removedPaths = oldFolderPaths.filter((oldPath) => !newPathsSet.has(oldPath));
        const addedPaths = newFolderPaths.filter((newPath) => !oldPathsSet.has(newPath));
        if (addedPaths.length > 0) {
            // handle added paths
            const parentPath = addedPaths[0].split('/').at(-2);
            const hostDirectories = addedPaths.filter((addedPath) => isHostDirectory(addedPath));
            console.assert(
                hostDirectories.length === addedPaths.length ||
                    addedPaths.every((newPath) => newPath.split('/').at(-2) === parentPath),
                'Perf dump: All newly selected paths should have the same parent path, or all be host directories.',
            );

            if (hostDirectories.length > 0) {
                const newHostEventsToPlot = hostDirectories
                    .map((hostPath) => {
                        const events = this.hostEventMap[hostPath];
                        if (!events || events.length === 0) {
                            console.error('Perf dump: null or empty new host events for selection:', hostPath);
                        }
                        return events;
                    })
                    .flat(1);
                this.filterOpsAndHostEvents();
                this.calculateFlexableBounds();
                this.calculateDrawingParameters();
                this.updatePlotHeight();
                this.reDrawOnHostEventSelect(newHostEventsToPlot);
            } else {
                const newOpsToPlot: Array<Op | CoreOp> = addedPaths
                    .map((newPath) =>
                        processDataOfNewFolderPath(newPath).filter((op: Op | CoreOp) =>
                            this.inputs.includes(`input-${op.input}`),
                        ),
                    )
                    .flat(1);
                if (!newOpsToPlot || newOpsToPlot.length === 0) {
                    console.warn('Perf dump: null or empty new ops.');
                } else {
                    this.filterOpsAndHostEvents();
                    this.calculateFlexableBounds();
                    this.calculateDrawingParameters();
                    this.updatePlotHeight();
                    this.reDrawOnOpSelect(newOpsToPlot);
                }
            }
        }
        // if the user deselected a graph
        else if (removedPaths.length > 0) {
            const hostDirectories = removedPaths.filter((removedPath) => isHostDirectory(removedPath));
            if (hostDirectories.length > 0) {
                const hostEventsToRemoveFromPlot = hostDirectories.map((dir) => this.hostEventMap[dir]).flat(1);
                if (!hostEventsToRemoveFromPlot || hostEventsToRemoveFromPlot.length === 0) {
                    console.error('Perf dump: null or empty host events to remove.');
                } else {
                    this.filterOpsAndHostEvents();
                    this.calculateFlexableBounds();
                    this.calculateDrawingParameters();
                    this.updatePlotHeight();
                    this.reDrawOnHostEventDeselect(hostEventsToRemoveFromPlot);
                }
            }
            if (removedPaths.length > hostDirectories.length) {
                const opsToRemoveFromPlot: Array<Op | CoreOp> = removedPaths
                    .map((removedPath) => removeDataOfFolderPath(removedPath))
                    .flat(1);
                if (!opsToRemoveFromPlot || opsToRemoveFromPlot.length === 0) {
                    console.error('Perf dump: null or empty ops to remove.');
                }
                this.filterOpsAndHostEvents();
                this.calculateFlexableBounds();
                this.calculateDrawingParameters();
                this.updatePlotHeight();
                this.reDrawOnOpDeselect(opsToRemoveFromPlot);
            }
        }
        this.zoomToDomain(domain);
        indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
    }

    // on showdramreads, showdramwrites, showmodelnumbers changes.
    // TODO: update so that we don't need to redraw
    updateDisplayEvents(newVisProps: PerfDumpVisProps): void {
        let newEvent;
        if (this.visProps.showAllDramReads != newVisProps.showAllDramReads) {
            newEvent = 'dram-reads';
        } else if (this.visProps.showAllDramWrites != newVisProps.showAllDramWrites) {
            newEvent = 'dram-writes';
        } else if (this.visProps.showModelNumbers != newVisProps.showModelNumbers) {
            newEvent = 'model-numbers';
        }
        this.visProps = newVisProps;
        // console.log("THIS.OPS: ", this.ops);
        for (const folderPath of Object.keys(this.ops)) {
            for (const op of this.ops[folderPath]) {
                op.visProps = newVisProps;
            }
        }
        const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
        this.plotSvg.selectAll('#cycleIndicator').remove();
        d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
        this.plotSvg.selectAll('#timePoint').remove();
        const domain = this.currentXScale.domain();
        // if (newEvent == "dram-reads") {

        // }
        this.calculateFlexableBounds();
        this.calculateDrawingParameters();

        this.draw();
        this.zoomToDomain(domain);
        indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
    }

    // on height, width changes.
    resizeSVG(newVisProps: PerfDumpVisProps): void {
        const domain = this.currentXScale.domain();
        this.visProps = newVisProps;
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
        const domain = this.currentXScale.domain();
        this.visProps = newVisProps;
        this.calculateDrawingParameters();
        this.updatePlotHeight();
        const bar_top = (op: Op | CoreOp): number => {
            const bar_top_core_op = (): number => {
                return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_TOP;
            };
            if (op instanceof CoreOp) {
                return bar_top_core_op();
            }
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            let sentHeight = 0;
            let clearedHeight = 0;
            if (op.dramWriteSent.length > 0 && this.visProps.showAllDramWrites) {
                sentHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites) {
                clearedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }

            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                issuedHeight +
                flushedHeight +
                sentHeight +
                clearedHeight +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };
        const bar_middle = (op: Op | CoreOp): number => bar_top(op) + op.barHeight / 2;
        const bar_bottom = (op: Op | CoreOp): number => bar_top(op) + op.barHeight;
        const bar_modelTop = (op: Op | CoreOp): number => bar_top(op) + op.barHeight;
        const bar_modelPropTop = (op: Op | CoreOp): number => bar_modelTop(op) + op.barHeight / 2;
        const bar_top_issued = (): number => {
            return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_TOP;
        };

        const bar_top_flushed = (op: Op): number => {
            let issuedHeight = 0;
            if (op.dramReadIssued.length > 0) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + issuedHeight + PerfDumpD3Controller.MARGIN_TOP;
        };

        const bar_top_sent = (op: Op): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN + issuedHeight + flushedHeight + PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_cleared = (op: Op): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            let sentHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramWriteSent.length > 0) {
                sentHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                issuedHeight +
                flushedHeight +
                sentHeight +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_incoming = (op: CoreOp, waitForIncomingTileId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = waitForIncomingTileId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_free = (op: CoreOp, waitForFreeTileId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights =
                (op as CoreOp).waitForIncomingTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = waitForFreeTileId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_unpacker = (op: CoreOp, triscStallOnDramUnpackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = op.waitForIncomingTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = op.waitForFreeTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallUnpackerHeights =
                triscStallOnDramUnpackerId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                +prevFreeHeights +
                prevTriscStallUnpackerHeights +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_packer = (op: CoreOp, triscStallOnDramPackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = op.waitForIncomingTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = op.waitForFreeTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallUnpackerHeights =
                op.triscStallOnDramUnpacker.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallPackerHeights =
                triscStallOnDramPackerId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights +
                prevTriscStallUnpackerHeights +
                prevTriscStallPackerHeights +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        // host events
        for (const event of this.hostEventsToPlot) {
            this.opBars
                .selectAll(`.host-event-${event.id}`)
                .attr('y', PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_TOP)
                .attr('height', event.barHeight);
        }
        // vertical line - start
        this.opBars.selectAll('.pd-candle-vs').attr('y1', bar_top).attr('y2', bar_bottom);

        // vertical line - end
        this.opBars.selectAll('.pd-candle-ve').attr('y1', bar_top).attr('y2', bar_bottom);

        // horizontal line - start
        this.opBars.selectAll('.pd-candle-hs').attr('y1', bar_middle).attr('y2', bar_middle);

        // horizontal line - end
        this.opBars.selectAll('.pd-candle-he').attr('y1', bar_middle).attr('y2', bar_middle);

        // middle bar
        this.opBars
            .selectAll('.pd-candle-bar')
            .attr('y', bar_top)
            .attr('height', (op: Op | CoreOp) => op.barHeight);

        if (this.visProps.showModelNumbers) {
            // model bar
            this.opBars
                .selectAll('.pd-candle-bar-model')
                .attr('y', bar_modelTop)
                .attr('height', (op: Op | CoreOp) =>
                    !op.outOfMemory && isNumber(op.modelCycles) ? op.barHeight / 2 : 0,
                );

            // model prop bar
            this.opBars
                .selectAll('.pd-candle-bar-model-prop')
                .attr('y', bar_modelPropTop)
                .attr('height', (op: Op | CoreOp) =>
                    !op.outOfMemory && isNumber(op.modelCyclesProp) ? op.barHeight / 2 : 0,
                );
        }
        for (const op of this.opsToPlot) {
            if (op instanceof Op) {
                // Update location of dram-read-chunk-read-issued ticks
                if (op.dramReadIssued.length > 0) {
                    this.opBars
                        .selectAll(`.dram-read-issued-op-id-${op.id}`)
                        .attr('y1', bar_top_issued())
                        .attr('y2', bar_top_issued() + op.barHeight / 2);
                }
                // Update location of dram-read-tile-flushed ticks
                if (op.dramReadFlushed.length > 0) {
                    this.opBars
                        .selectAll(`.dram-read-flushed-op-id-${op.id}`)
                        .attr('y1', bar_top_flushed(op))
                        .attr('y2', bar_top_flushed(op) + op.barHeight / 2);
                }
                // Update location of dram-write-sent-tile ticks
                if (op.dramWriteSent.length > 0) {
                    this.opBars
                        .selectAll(`.dram-write-sent-op-id-${op.id}`)
                        .attr('y1', bar_top_sent(op))
                        .attr('y2', bar_top_sent(op) + op.barHeight / 2);
                }
                // Update location of dram-write-tile-cleared ticks
                if (op.dramWriteCleared.length > 0) {
                    this.opBars
                        .selectAll(`.dram-write-cleared-op-id-${op.id}`)
                        .attr('y1', bar_top_cleared(op))
                        .attr('y2', bar_top_cleared(op) + op.barHeight / 2);
                }
            } else if (op instanceof CoreOp) {
                if (op instanceof CoreOp && op.waitForIncomingTiles.size > 0) {
                    for (
                        let waitForIncomingTileId = 0;
                        waitForIncomingTileId < op.waitForIncomingTiles.size;
                        waitForIncomingTileId++
                    ) {
                        this.opBars
                            .selectAll(`.coreOp-id-${op.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId}`)
                            .attr('y', bar_top_incoming(op, waitForIncomingTileId))
                            .attr('height', op.barHeight);
                    }
                }
                if (op instanceof CoreOp && op.waitForFreeTiles.size > 0) {
                    for (let waitForFreeTileId = 0; waitForFreeTileId < op.waitForFreeTiles.size; waitForFreeTileId++) {
                        this.opBars
                            .selectAll(`.coreOp-id-${op.id}-wait-for-free-tiles-id-${waitForFreeTileId}`)
                            .attr('y', bar_top_free(op, waitForFreeTileId))
                            .attr('height', op.barHeight);
                    }
                }
                if (op.triscStallOnDramUnpacker.size > 0) {
                    for (
                        let triscStallOnDramUnpackerId = 0;
                        triscStallOnDramUnpackerId < op.triscStallOnDramUnpacker.size;
                        triscStallOnDramUnpackerId++
                    ) {
                        this.opBars
                            .selectAll(`.coreOp-id-${op.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId}`)
                            .attr('y', bar_top_unpacker(op, triscStallOnDramUnpackerId))
                            .attr('height', op.barHeight);
                    }
                }
                if (op.triscStallOnDramPacker.size > 0) {
                    for (
                        let triscStallOnDramPackerId = 0;
                        triscStallOnDramPackerId < op.triscStallOnDramPacker.size;
                        triscStallOnDramPackerId++
                    ) {
                        this.opBars
                            .selectAll(`.coreOp-id-${op.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId}`)
                            .attr('y', bar_top_packer(op, triscStallOnDramPackerId))
                            .attr('height', op.barHeight);
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
                    `translate(${0},${this.hostEventOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
        this.opBars
            .selectAll('.g-ops')
            .attr(
                'transform',
                (op: Op | CoreOp) =>
                    `translate(${0},${this.hostEventOpIndexMap[op.fullName] * this.BAR_REGION_HEIGHT})`,
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
        for (const folderPath of Object.keys(this.ops)) {
            for (const op of this.ops[folderPath]) {
                op.switchToFrequency(this.frequency);
                for (const coreOp of op.coreOps) {
                    coreOp.switchToFrequency(this.frequency);
                }
            }
        }
        this.calculateFlexableBounds();
        this.updateXScaleDomainAndApplyToBars();
    }

    updateUnit(newUnit: Unit): void {
        this.visProps.unit = newUnit;
        this.unit = this.visProps.unit;
        for (const folderPath of Object.keys(this.ops)) {
            for (const op of this.ops[folderPath]) {
                op.switchToUnit(this.unit);
                for (const coreOp of op.coreOps) {
                    coreOp.switchToUnit(this.unit);
                }
            }
        }
        this.calculateFlexableBounds();
        this.updateXScaleDomainAndApplyToBars();
    }

    updateXYOrder(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        for (const folderPath of Object.keys(this.ops)) {
            for (const op of this.ops[folderPath]) {
                for (const coreOp of op.coreOps) {
                    coreOp.xyOrder = this.visProps.xyOrder;
                    coreOp.name = `${coreOp.getCoreString()}-${coreOp.parent.name}`;
                }
            }
        }

        for (let i = 0; i < this.opsToPlot.length; i++) {
            if (this.opsToPlot[i] instanceof CoreOp) {
                for (let j = i + 1; j < this.opsToPlot.length; j++) {
                    if (this.opsToPlot[j] instanceof Op) {
                        this.opsToPlot = partialSort(this.opsToPlot, i, j, (a: CoreOp, b: CoreOp) => {
                            let t = a.name.split('-');
                            const a_x = t[0];
                            const a_y = t[1];
                            t = b.name.split('-');
                            const b_x = t[0];
                            const b_y = t[1];

                            return a_x != b_x ? parseInt(a_x) - parseInt(b_x) : parseInt(a_y) - parseInt(b_y);
                        });
                        i = j;
                        break;
                    }
                }
            }
        }

        let index = this.hostEventsToPlot.length;
        for (const op of this.opsToPlot) {
            this.hostEventOpIndexMap[op.fullName] = index;
            index += 1;
        }

        this.updateHostEventNames();
        this.updateDeviceOpNames();
        this.draw();
    }

    sortOpsAndHostEvents(): void {
        // Order of ops of later inputs should match the order of input 0
        this.folderPathSortedOpMap = {};
        // console.log("FOLDER PATH FIRST INPUT OP MAP: ", this.folderPathFirstInputOpMap);
        // console.log("ALL FOLDER PATHS: ", this.allFolderPaths);
        for (const folderPath of this.allFolderPaths) {
            if (isHostDirectory(folderPath)) {
                // sort host events within the same host folder by end time
                this.hostEventMap[folderPath].sort((a: HostEvent, b: HostEvent) => {
                    if (a.process !== b.process) {
                        return parseInt(a.process) - parseInt(b.process);
                    }
                    return a.latestEnd - b.latestEnd;
                });
                continue;
            }
            const epochPath = folderPath;
            let sortedOps: Op[] = [];
            // extract only ops that have the earliest input among ops that have the same name
            const earliestInputOps = Object.values(this.epochFirstInputOpMap[epochPath]);
            earliestInputOps.sort((a: Op, b: Op) => a.latestTrisc() - b.latestTrisc());

            // contains the names of ops which were sorted by the endtime of their first input id.
            const orderedOpNames = earliestInputOps.map((op: Op) => op.opName);

            // console.log("FOLDER PATH OP MAP: ", this.folderPathOpMap)
            // loop through ordered op names, extract all ops with that op name in this epoch and sort those ops by input id.
            for (const opName of orderedOpNames) {
                const allInputOps = this.folderPathOpMap[epochPath][opName];
                console.assert(allInputOps !== undefined, 'allInputsOps undefined in sort ops of perf dump d3');
                allInputOps.sort((a: Op, b: Op) => a.input - b.input);
                sortedOps = sortedOps.concat(allInputOps);
            }
            this.folderPathSortedOpMap[epochPath] = sortedOps;
        }

        for (const folderPath of Object.keys(this.ops)) {
            for (const op of this.ops[folderPath]) {
                op.coreOps.sort((c1: CoreOp, c2: CoreOp) => sortCores(c1.getCoreString(), c2.getCoreString()));
            }
        }
    }

    // extract ops we want to plot from all ops (folderPathSortedOpMap)
    // or extract host events we want to plot from all host events (hostEventMap)
    filterOpsAndHostEvents(): void {
        // console.log(this.epochs)
        // append expanded core-ops to ops we want to plot
        // console.log("FOLDER PATHS: ", this.folderPaths);
        // console.log("FOLDER PATH SORTED OP MAP: ", this.folderPathSortedOpMap);
        this.opsToPlot = [];
        this.hostEventsToPlot = [];
        this.hostEventOpIndexMap = {};
        if (this.folderPaths.length === 0) {
            return;
        }
        for (const folderPath of this.folderPaths) {
            if (isHostDirectory(folderPath)) {
                this.hostEventsToPlot = this.hostEventsToPlot.concat(this.hostEventMap[folderPath]);
                continue;
            }
            if (!this.folderPathSortedOpMap[folderPath]) {
                console.log('Perf dump: folder path does not exist in sorted set.', folderPath);
            }
            if (!this.folderPathOpMap[folderPath]) {
                console.log('Perf dump: folder path does not exist in unsorted set.', folderPath);
            }
            for (const op of this.folderPathSortedOpMap[folderPath]) {
                if (!this.inputs.includes(`input-${op.input}`)) {
                    continue;
                }
                this.opsToPlot.push(op);
                if (op.expanded) {
                    this.opsToPlot = this.opsToPlot.concat(op.coreOps);
                    // console.log("COREOPS:", op.coreOps);
                }
            }
        }
        let index = 0;
        for (const hostEvent of this.hostEventsToPlot) {
            this.hostEventOpIndexMap[hostEvent.fullName] = index;
            index += 1;
        }
        for (const op of this.opsToPlot) {
            this.hostEventOpIndexMap[op.fullName] = index;
            index += 1;
        }
        // console.log("Host event op index map: ", this.hostEventOpIndexMap);
    }

    calculateFlexableBounds(): void {
        this.fixedXscaleStart = Infinity;
        this.fixedXscaleEnd = 0;
        for (const folderPath of this.folderPaths) {
            if (isHostDirectory(folderPath)) {
                console.assert((this.unit = Unit.NS), 'Perf dump: host directory exists but unit not in nanoseconds');
                if (!this.hostData || !this.hostData.has(folderPath)) {
                    console.error("Perf Dump: Host data doesn't exist or folder path doesnt exist.");
                    continue;
                }
                const data = this.hostData.get(folderPath);
                if (isNumber(data!['min-start'])) {
                    this.fixedXscaleStart = Math.min(this.fixedXscaleStart, data!['min-start']);
                }
                if (isNumber(data!['max-end'])) {
                    this.fixedXscaleEnd = Math.max(this.fixedXscaleEnd, data!['max-end']);
                }
                continue;
            }
            if (!this.data || !this.data.has(folderPath)) {
                console.error("Perf Dump: Host data doesn't exist or folder path doesnt exist.");
                continue;
            }
            const data = this.data.get(folderPath);
            if (this.unit == Unit.CYCLES) {
                if (isNumber(data!['perf-dump-min-start'])) {
                    this.fixedXscaleStart = Math.min(this.fixedXscaleStart, data!['perf-dump-min-start-cycles']);
                }
                if (isNumber(data!['perf-dump-max-end'])) {
                    this.fixedXscaleEnd = Math.max(this.fixedXscaleEnd, data!['perf-dump-max-end-cycles']);
                }
            } else if (this.unit == Unit.NS && this.frequency == Frequency.DERIVED) {
                if (isNumber(data!['perf-dump-min-start-ns-derived'])) {
                    this.fixedXscaleStart = Math.min(this.fixedXscaleStart, data!['perf-dump-min-start-ns-derived']);
                }
                if (isNumber(data!['perf-dump-max-end-ns-derived'])) {
                    this.fixedXscaleEnd = Math.max(this.fixedXscaleEnd, data!['perf-dump-max-end-ns-derived']);
                }
            } else if (this.unit == Unit.NS && this.frequency == Frequency.AICLK) {
                if (isNumber(data!['perf-dump-min-start-ns-aiclk'])) {
                    this.fixedXscaleStart = Math.min(this.fixedXscaleStart, data!['perf-dump-min-start-ns-aiclk']);
                }
                if (isNumber(data!['perf-dump-max-end-ns-aiclk'])) {
                    this.fixedXscaleEnd = Math.max(this.fixedXscaleEnd, data!['perf-dump-max-end-ns-aiclk']);
                }
            } else {
                console.error('Perf dump: unexpected unit or frequency.');
            }
        }
        // console.log("Global start: ", this.fixedXscaleStart);
        // console.log("Global end: ", this.fixedXscaleEnd);

        this.startCycle = Infinity;
        this.endCycle = 0;
        if (this.hostEventsToPlot.length > 0) {
            this.startCycle = this.hostEventsToPlot.reduce((start: number, event: HostEvent): number => {
                const es = event.earliestStart;
                return Math.min(es, start);
            }, this.startCycle);

            this.endCycle = this.hostEventsToPlot.reduce((end: number, event: HostEvent): number => {
                const le = event.latestEnd;
                return Math.max(le, end);
            }, this.endCycle);
        }

        if (this.opsToPlot.length == 0) {
            return;
        } // nothing to do

        // Figure out start/end bounds
        if (this.showTrisc) {
            this.startCycle = this.opsToPlot.reduce((start: number, op: Op | CoreOp) => {
                if (op instanceof CoreOp) {
                    return start;
                }
                const es = op.earliestTrisc();
                return Math.min(es, start);
            }, this.startCycle);

            this.endCycle = this.opsToPlot.reduce((end: number, op: Op | CoreOp) => {
                if (op instanceof CoreOp) {
                    return end;
                }
                const le = op.latestTrisc();
                return Math.max(le, end);
            }, this.endCycle);
        }

        for (const op of this.opsToPlot) {
            if (op instanceof Op && op.expanded) {
                this.startCycle = Math.min(this.startCycle, op.earliestWaitForTile(), op.earliestTriscStallOnDram());
            }
        }

        // Note: If we choose to not display trisc, check if startcycle/endcycle exists
        if (this.visProps.showAllDramReads) {
            this.startCycle = this.opsToPlot.reduce((start: number, op: Op | CoreOp) => {
                if (op instanceof CoreOp) {
                    return start;
                }
                const es = op.earliestRead();
                return Math.min(es, start);
            }, this.startCycle);

            this.endCycle = this.opsToPlot.reduce((end: number, op: Op | CoreOp) => {
                if (op instanceof CoreOp) {
                    return end;
                }
                const le = op.latestRead();
                return Math.max(le, end);
            }, this.endCycle);
        }

        // Note: If we choose to not display trisc, check if startcycle/endcycle exists
        if (this.visProps.showAllDramWrites) {
            this.startCycle = this.opsToPlot.reduce((start: number, op: Op | CoreOp) => {
                if (op instanceof CoreOp) {
                    return start;
                }
                const es = op.earliestWrite();
                return Math.min(es, start);
            }, this.startCycle);

            this.endCycle = this.opsToPlot.reduce((end: number, op: Op | CoreOp) => {
                if (op instanceof CoreOp) {
                    return end;
                }
                const le = op.latestWrite();
                return Math.max(le, end);
            }, this.endCycle);
        }

        if (this.visProps.showModelNumbers) {
            this.endCycle = this.opsToPlot.reduce((end: number, op: Op | CoreOp) => {
                if (!op.modelCyclesProp || op.bounds.medLow == undefined) {
                    return end;
                }
                const le = op.bounds.medLow - this.startCycle + op.modelCyclesProp;
                return Math.max(le, end);
            }, this.endCycle);
        }

        this.opsToPlot.forEach((op: Op | CoreOp) => op.setLeftBound(this.startCycle));
    }

    // Y coordinate of the text on the left (op names)
    bar_text_line_y = (_, index: number): number =>
        PerfDumpD3Controller.MARGIN_SHIFT_DOWN + (index + 1) * this.BAR_REGION_HEIGHT - this.BAR_REGION_HEIGHT / 150;

    bar_fill = (op: Op | CoreOp): string => {
        // console.log(op.bounds)
        const input_num = op instanceof Op ? op.input : op.parent.input;

        const input_index = this.allInputs.indexOf(`input-${input_num}`);
        if (input_index >= 0) {
            return this.inputColors(input_index);
        }
        return 'green';
    };

    highlight(label: string): void {
        this.opNames.selectAll('text').attr('fill', (e: HostEvent | Op | CoreOp) => {
            if (e.name.includes(label)) {
                return '#00FFFF';
            }
            if (e instanceof HostEvent) {
                return 'white';
            }
            if (e instanceof Op) {
                return e.outOfMemory ? 'red' : 'white';
            }
            return e.outOfMemory ? 'red' : '#33ccff';
        });
    }

    createHostBars(regions: any): void {
        const { hostEventColors } = this;
        const { allProcesses } = this;
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

        const colors = ['#e4d00a', '#9b870c'];
        const hostColor = ['#FFBF00', '#EEBC1D', '#d99058', '#da9100', '#f4c430'];
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
                .filter((e: HostEvent | Op | CoreOp) => e instanceof HostEvent && e.fullName == box.fullName)
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
                .filter((e: HostEvent | Op | CoreOp) => e instanceof HostEvent && e.fullName == box.fullName)
                .attr('fill', 'white');
        }

        for (const event of eventsToUpdate) {
            eventRegions
                .selectAll(`.host-event-${event.id}`)
                .attr('x', (box: Box) => this.currentXScale(box.low - this.startCycle))
                .attr('y', PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_TOP)
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
                    `translate(${0},${this.hostEventOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
    }

    updateHostBarSeparators(): void {
        for (let i = 0; i < this.hostEventsToPlot.length; i++) {
            let folderPathChange = false;
            const line_top = (): number => {
                const padding = this.BAR_REGION_HEIGHT / 150;
                return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + this.BAR_REGION_HEIGHT - padding;
            };
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
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
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
            .attr('x2', PerfDumpD3Controller.MARGIN_LEFT)
            .attr('y1', this.bar_text_line_y)
            .attr('y2', this.bar_text_line_y);
    }

    createDeviceBars(regions: any): void {
        console.log('Creating device bars');
        // vertical line - start
        regions
            .append('line')
            .attr('class', 'pd-candle-vs')
            .attr('stroke', 'white')
            .attr('stroke-width', 2)
            .style('shape-rendering', 'optimizeSpeed')
            .style('vector-effect', 'non-scaling-stroke');

        // vertical line - end
        regions
            .append('line')
            .attr('class', 'pd-candle-ve')
            .attr('stroke', 'white')
            .attr('stroke-width', 2)
            .style('shape-rendering', 'optimizeSpeed')
            .style('vector-effect', 'non-scaling-stroke');

        // horizontal line - start
        regions
            .append('line')
            .attr('class', 'pd-candle-hs')
            .attr('stroke', 'white')
            .attr('stroke-width', 2)
            .style('shape-rendering', 'optimizeSpeed')
            .style('vector-effect', 'non-scaling-stroke');

        // horizontal line - end
        regions
            .append('line')
            .attr('class', 'pd-candle-he')
            .attr('stroke', 'white')
            .attr('stroke-width', 2)
            .style('shape-rendering', 'optimizeSpeed')
            .style('vector-effect', 'non-scaling-stroke');

        // middle bar
        regions
            .append('rect')
            .attr('class', 'pd-candle-bar')
            .attr('stroke', 'white')
            .attr('stroke-width', 2)
            .attr('fill', this.bar_fill)
            .style('cursor', 'pointer')
            .style('shape-rendering', 'optimizeSpeed')
            .style('vector-effect', 'non-scaling-stroke');

        // model bar
        regions
            .append('rect')
            .attr('class', 'pd-candle-bar-model')
            .attr('stroke', '#333')
            .attr('stroke-width', 1)
            .attr('fill', '#72deff')
            .style('shape-rendering', 'optimizeSpeed')
            .style('vector-effect', 'non-scaling-stroke');

        // model prop bar
        regions
            .append('rect')
            .attr('class', 'pd-candle-bar-model-prop')
            .attr('stroke', '#333')
            .attr('stroke-width', 1)
            .attr('fill', '#988bd0')
            .style('shape-rendering', 'optimizeSpeed')
            .style('vector-effect', 'non-scaling-stroke');

        const { opColors } = this;

        // expanded coreOps
        regions.each(function (this: any, op: Op | CoreOp) {
            if (!(op instanceof CoreOp)) {
                return;
            }
            if (op.waitForIncomingTiles.size > 0) {
                let waitForIncomingTileId = 0;
                for (const [key, value] of op.waitForIncomingTiles) {
                    d3.select(this)
                        .selectAll(`.coreOp-id-${op.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `coreOp-id-${op.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId} ` +
                                `perf-dump-rect-element`,
                        )
                        .attr('id', 'wait-for-incoming-tiles')
                        .attr('stroke', 'white')
                        .attr('stroke-width', 1)
                        .attr('fill', opColors.wait_for_tile)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                    waitForIncomingTileId += 1;
                }
            }

            if (op.waitForFreeTiles.size > 0) {
                let waitForFreeTileId = 0;
                for (const [key, value] of op.waitForFreeTiles) {
                    d3.select(this)
                        .selectAll(`.coreOp-id-${op.id}-wait-for-free-tiles-id-${waitForFreeTileId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `coreOp-id-${op.id}-wait-for-free-tiles-id-${waitForFreeTileId} ` +
                                `perf-dump-rect-element`,
                        )
                        .attr('id', 'wait-for-free-tiles')
                        .attr('stroke', 'white')
                        .attr('stroke-width', 1)
                        .attr('fill', opColors.wait_for_free_tile)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                    waitForFreeTileId += 1;
                }
            }

            if (op.triscStallOnDramUnpacker.size > 0) {
                let triscStallOnDramUnpackerId = 0;
                for (const [key, value] of op.triscStallOnDramUnpacker) {
                    d3.select(this)
                        .selectAll(`.coreOp-id-${op.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `coreOp-id-${op.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId} ` +
                                `perf-dump-rect-element`,
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

            if (op.triscStallOnDramPacker.size > 0) {
                let triscStallOnDramPackerId = 0;
                for (const [key, value] of op.triscStallOnDramPacker) {
                    d3.select(this)
                        .selectAll(`.coreOp-id-${op.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId}`)
                        .data(value)
                        .enter()
                        .append('rect')
                        .attr(
                            'class',
                            `coreOp-id-${op.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId} ` +
                                `perf-dump-rect-element`,
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
            regions.each(function (this: any, op: Op | CoreOp) {
                if (op instanceof Op && op.dramReadIssued.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-read-issued-op-id-${op.id}`)
                        .data((op: Op) => op.dramReadIssued)
                        .enter()
                        .append('line')
                        .attr('class', `dram-read-issued-op-id-${op.id} ` + `perf-dump-plotted-line-element`)
                        .attr('id', 'dram-read-issued')
                        .attr('stroke', opColors.dram_read_issued)
                        .attr('stroke-width', 2)
                        .style('opacity', 0)
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }

                if (op instanceof Op && op.dramReadFlushed.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-read-flushed-op-id${op.id}`)
                        .data((op: Op) => op.dramReadFlushed)
                        .enter()
                        .append('line')
                        .attr('class', `dram-read-flushed-op-id-${op.id} ` + `perf-dump-plotted-line-element`)
                        .attr('id', 'dram-read-flushed')
                        .attr('stroke', opColors.dram_read_flushed)
                        .attr('stroke-width', 2)
                        .style('opacity', 0)
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            });
        }

        if (this.visProps.showAllDramWrites) {
            regions.each(function (this: any, op: Op | CoreOp) {
                if (op instanceof Op && op.dramWriteSent.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-write-sent-op-id-${op.id}`)
                        .data((op: Op) => op.dramWriteSent)
                        .enter()
                        .append('line')
                        .attr('class', `dram-write-sent-op-id-${op.id} ` + `perf-dump-plotted-line-element`)
                        .attr('id', 'dram-write-sent')
                        .attr('stroke', opColors.dram_write_sent)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }

                if (op instanceof Op && op.dramWriteCleared.length > 0) {
                    d3.select(this)
                        .selectAll(`.dram-write-cleared-op-id${op.id}`)
                        .data((op: Op) => op.dramWriteCleared)
                        .enter()
                        .append('line')
                        .attr('class', `dram-write-cleared-op-id-${op.id} ` + `perf-dump-plotted-line-element`)
                        .attr('id', 'dram-write-cleared')
                        .attr('stroke', opColors.dram_write_tile_cleared)
                        .attr('stroke-width', 2)
                        .style('cursor', 'pointer')
                        .style('shape-rendering', 'optimizeSpeed')
                        .style('vector-effect', 'non-scaling-stroke');
                }
            });
        }

        regions.each(function (this: any, op: Op | CoreOp) {
            d3.select(this)
                .append('line')
                .attr('class', `separator-${op.id}`)
                .attr('id', 'plot-separator')
                .attr('stroke-width', 1);
        });
    }

    // first time draw of device op bars
    drawDeviceBars(): void {
        console.log('#### PERFDUMP D3: DRAW DEVICE BARS ####');
        const regions = this.opBars
            .selectAll('.g-ops')
            .data(this.opsToPlot)
            .enter()
            .append('g')
            .attr('class', (op: Op | CoreOp) => `g-ops g-op-${op.id}`);

        this.createDeviceBars(regions);
    }

    updateTriscBars(opBars: any): void {
        const bar_low = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.low! - this.startCycle) : 0;
        };
        const bar_medLow = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.medLow! - this.startCycle) : 0;
        };

        const bar_high = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.high! - this.startCycle) : 0;
        };

        const bar_medHigh = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.medHigh! - this.startCycle) : 0;
        };
        // End of model and modelprop bars (These bars start at medLow of silicon data bars)
        const bar_model = (op: Op | CoreOp): number => {
            return !op.outOfMemory && isNumber(op.modelCycles)
                ? this.currentXScale(op.bounds.medLow! - this.startCycle + op.modelCycles!)
                : 0;
        };

        const bar_modelProp = (op: Op | CoreOp): number => {
            return !op.outOfMemory && isNumber(op.modelCyclesProp)
                ? this.currentXScale(op.bounds.medLow! - this.startCycle + op.modelCyclesProp!)
                : 0;
        };

        const bar_top = (op: Op | CoreOp): number => {
            const bar_top_core_op = (): number => {
                return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_TOP;
            };
            if (op instanceof CoreOp) {
                return bar_top_core_op();
            }
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            let sentHeight = 0;
            let clearedHeight = 0;
            if (op.dramWriteSent.length > 0 && this.visProps.showAllDramWrites) {
                sentHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramWriteCleared.length > 0 && this.visProps.showAllDramWrites) {
                clearedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }

            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                issuedHeight +
                flushedHeight +
                sentHeight +
                clearedHeight +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_modelTop = (op: Op | CoreOp): number => bar_top(op) + op.barHeight;
        const bar_modelPropTop = (op: Op | CoreOp): number => bar_modelTop(op) + op.barHeight / 2;
        const bar_bottom = (op: Op | CoreOp): number => bar_top(op) + op.barHeight;
        const bar_middle = (op: Op | CoreOp): number => bar_top(op) + op.barHeight / 2;
        const { bar_fill } = this;
        // vertical line - start
        opBars
            .selectAll('.pd-candle-vs')
            .attr('x1', bar_low)
            .attr('x2', bar_low)
            .attr('y1', bar_top)
            .attr('y2', bar_bottom)
            .style('opacity', (op: Op | CoreOp) => (op.outOfMemory == false ? 1 : 0));

        // vertical line - end
        opBars
            .selectAll('.pd-candle-ve')
            .attr('x1', bar_high)
            .attr('x2', bar_high)
            .attr('y1', bar_top)
            .attr('y2', bar_bottom)
            .style('opacity', (op: Op | CoreOp) => (op.outOfMemory == false ? 1 : 0));

        // horizontal line - start
        opBars
            .selectAll('.pd-candle-hs')
            .attr('x1', bar_low)
            .attr('x2', bar_medLow)
            .attr('y1', bar_middle)
            .attr('y2', bar_middle)
            .style('opacity', (op: Op | CoreOp) => (op.outOfMemory == false ? 1 : 0));

        // horizontal line - end
        opBars
            .selectAll('.pd-candle-he')
            .attr('x1', bar_medHigh)
            .attr('x2', bar_high)
            .attr('y1', bar_middle)
            .attr('y2', bar_middle)
            .style('opacity', (op: Op | CoreOp) => (op.outOfMemory == false ? 1 : 0));

        const { d3Ref } = this;
        const { opNames } = this;
        function handleMouseOver(this: SVGGraphicsElement, d, op: Op | CoreOp) {
            const text: string[] = [];
            if (op instanceof Op) {
                const cores = op.coreOps
                    .map((coreOp: CoreOp) => coreOp.getCoreString())
                    .sort(sortCores)
                    .map((core: string) => `(${core})`);

                const mathUtil = twoDecimals(op.mathUtilization * 100);
                text.push(
                    '<tr>',
                    '<td id="Trisc">' + '<span style="color:black">' + 'Trisc Aggregated Op' + '</span>' + '</td>',
                    '<br>',

                    `<td id="Name">` +
                        `<span style="color:black">` +
                        `Op: ` +
                        `</span>` +
                        `</span>` +
                        `<span style="color:blue">${op.opName}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="GraphId">` +
                        `<span style="color:black">` +
                        `Graph id: ` +
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
                        `<span style="color:blue">${op.input}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="Cores">` +
                        `<span style="color:black">` +
                        `Cores: ` +
                        `</span>` +
                        `<span style="color:blue">${cores.join(' ')}</span>` +
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
                        `Earliest start: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(
                            !op.outOfMemory ? op.bounds.low! - op.leftBound : 'N/A',
                        )}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="LatestEnd">` +
                        `<span style="color:black">` +
                        `Latest end: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(
                            !op.outOfMemory ? op.bounds.high! - op.leftBound : 'N/A',
                        )}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="MaxDiff">` +
                        `<span style="color:black">` +
                        `Latest-earliest diff: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(
                            !op.outOfMemory ? op.bounds.high! - op.bounds.low! : 'N/A',
                        )}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="MedianStart">` +
                        `<span style="color:black">` +
                        `Median start: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(
                            !op.outOfMemory ? op.bounds.medLow! - op.leftBound : 'N/A',
                        )}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="MedianEnd">` +
                        `<span style="color:black">` +
                        `Median end: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(
                            !op.outOfMemory ? op.bounds.medHigh! - op.leftBound : 'N/A',
                        )}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="MedianDiff">` +
                        `<span style="color:black">` +
                        `Median diff: ` +
                        `</span>` +
                        `<span style="color:blue">${d3.format(',')(
                            !op.outOfMemory ? op.bounds.medHigh! - op.bounds.medLow! : 'N/A',
                        )}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="MathUtil">` +
                        `<span style="color:black">` +
                        `Math-utilization: ` +
                        `</span>` +
                        `<span style="color:blue">${isNumber(mathUtil) ? `${mathUtil}%` : 'N/A'}</span>` +
                        `</td>`,
                    '</tr>',
                );
            } else if (op instanceof CoreOp) {
                text.push(
                    '<tr>',
                    '<td id="Trisc">' + '<span style="color:black">' + 'Trisc Core Op' + '</span>' + '</td>',
                    '<br>',
                    `<td id="Name">` +
                        `<span style="color:black">` +
                        `Op: ` +
                        `</span>` +
                        `</span>` +
                        `<span style="color:blue">${op.opName}</span>` +
                        `</td>`,
                    '<br>',
                    `<td id="GraphId">` +
                        `<span style="color:black">` +
                        `Graph id: ` +
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
                        `<span style="color:blue">${op.input}</span>` +
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
                    '</tr>',
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
                for (const unpackBw of Object.keys(op.unpackBw)) {
                    const val = twoDecimals(op.unpackBw[unpackBw]);
                    text.push(
                        '<br>',
                        `<td id="unpackBw">` +
                            `<span style="color:black">${capitalize(unpackBw)}: ` +
                            `</span>` +
                            `<span style="color:blue">${isNumber(val) ? val : 'N/A'}</span>` +
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
            }

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
                .filter((e: HostEvent | Op | CoreOp) => !(e instanceof HostEvent) && e.fullName == op.fullName)
                .attr('fill', '#00FFFF');
        }

        function handleMouseOut(this: SVGGraphicsElement, d, op: Op | CoreOp) {
            d3.select(this).attr('fill', bar_fill(op));
            d3.select(d3Ref).selectAll('#tooltip').remove();
            d3.select(d3Ref)
                .append('div')
                .attr('id', 'tooltip')
                .attr('style', 'position: absolute;')
                .style('opacity', 0);

            opNames
                .selectAll('text')
                .filter((e: HostEvent | Op | CoreOp) => !(e instanceof HostEvent) && e.fullName == op.fullName)
                .attr('fill', (e: Op | CoreOp) => (e.outOfMemory ? 'red' : e instanceof Op ? 'white' : '#33ccff'));
        }
        // middle bar
        opBars
            .selectAll('.pd-candle-bar')
            .attr('x', bar_medLow)
            .attr('y', bar_top)
            .attr('width', (op: Op | CoreOp) => {
                const width = !op.outOfMemory ? bar_medHigh(op) - bar_medLow(op) : 0;
                return width;
            })
            .attr('height', (op: Op | CoreOp) => op.barHeight)
            .attr('visibility', (op: Op | CoreOp) => (op.outOfMemory == false ? '' : 'hidden'))
            .on('mouseover', handleMouseOver)
            .on('mouseout', handleMouseOut);

        if (this.visProps.showModelNumbers) {
            // model bar
            opBars
                .selectAll('.pd-candle-bar-model')
                .attr('x', bar_medLow)
                .attr('y', bar_modelTop)
                .attr('width', (op: Op | CoreOp) =>
                    !op.outOfMemory && isNumber(op.modelCycles) ? bar_model(op) - bar_medLow(op) : 0,
                )
                .attr('height', (op: Op | CoreOp) =>
                    !op.outOfMemory && isNumber(op.modelCycles) ? op.barHeight / 2 : 0,
                );

            // model prop bar
            opBars
                .selectAll('.pd-candle-bar-model-prop')
                .attr('x', bar_medLow)
                .attr('y', bar_modelPropTop)
                .attr('width', (op: Op | CoreOp) =>
                    !op.outOfMemory && isNumber(op.modelCyclesProp) ? bar_modelProp(op) - bar_medLow(op) : 0,
                )
                .attr('height', (op: Op | CoreOp) =>
                    !op.outOfMemory && isNumber(op.modelCyclesProp) ? op.barHeight / 2 : 0,
                );
        }
    }

    updateDramReadTicks(opBars: any, opsToUpdate: Array<Op | CoreOp>): void {
        const { d3Ref } = this;

        const bar_top_issued = (): number => {
            return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_TOP;
        };

        const bar_top_flushed = (op: Op): number => {
            let issuedHeight = 0;
            if (op.dramReadIssued.length > 0) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + issuedHeight + PerfDumpD3Controller.MARGIN_TOP;
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

        for (const op of opsToUpdate) {
            // Update location of dram-read-chunk-read-issued ticks
            if (op instanceof Op && op.dramReadIssued.length > 0) {
                function handleMouseOverIssued(this: SVGGraphicsElement, d, line: Line) {
                    const text: string[] = [];
                    const index = dramReadIssuedCycles.nodes().indexOf(this);
                    text.push(
                        '<tr>',
                        '<td id="field">' +
                            '<span style="color:black">' +
                            'Dram Read Chunk Issued' +
                            '</span>' +
                            '</td>',
                        '<br>',
                        `<td id="unit">` +
                            `<span style="color:black">` +
                            `Unit: ` +
                            `</span>` +
                            `<span style="color:blue">${line.unit}</span>` +
                            `</td>`,
                        '<br>',
                        // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                        // '<br>',
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

                const dramReadIssuedCycles = opBars
                    .selectAll(`.dram-read-issued-op-id-${op.id}`)
                    .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('y1', bar_top_issued())
                    .attr('y2', bar_top_issued() + op.barHeight / 2)
                    .style('opacity', 1)
                    .style('cursor', 'pointer')
                    .on('mouseover', handleMouseOverIssued)
                    .on('mouseout', handleMouseOut);
            }
            // Update location of dram-read-tile-flushed ticks
            if (op instanceof Op && op.dramReadFlushed.length > 0) {
                function handleMouseOverFlushed(this: SVGGraphicsElement, d, line: Line) {
                    const text: string[] = [];
                    const index = dramReadFlushedCycles.nodes().indexOf(this);
                    text.push(
                        '<tr>',
                        '<td id="field">' +
                            '<span style="color:black">' +
                            'Dram Read Tiles Flushed' +
                            '</span>' +
                            '</td>',
                        '<br>',
                        `<td id="unit">` +
                            `<span style="color:black">` +
                            `Unit: ` +
                            `</span>` +
                            `<span style="color:blue">${line.unit}</span>` +
                            `</td>`,
                        '<br>',
                        // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                        // '<br>',
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

                const dramReadFlushedCycles = opBars
                    .selectAll(`.dram-read-flushed-op-id-${op.id}`)
                    .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('y1', bar_top_flushed(op))
                    .attr('y2', bar_top_flushed(op) + op.barHeight / 2)
                    .style('opacity', 1)
                    .style('cursor', 'pointer')
                    .on('mouseover', handleMouseOverFlushed)
                    .on('mouseout', handleMouseOut);
            }
        }
    }

    updateDramWriteTicks(opBars: any, opsToUpdate: Array<Op | CoreOp>): void {
        const { d3Ref } = this;
        const bar_top_sent = (op: Op): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN + issuedHeight + flushedHeight + PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_cleared = (op: Op): number => {
            let issuedHeight = 0;
            let flushedHeight = 0;
            let sentHeight = 0;
            if (op.dramReadIssued.length > 0 && this.visProps.showAllDramReads) {
                issuedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramReadFlushed.length > 0 && this.visProps.showAllDramReads) {
                flushedHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            if (op.dramWriteSent.length > 0) {
                sentHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight / 2;
            }
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                issuedHeight +
                flushedHeight +
                sentHeight +
                PerfDumpD3Controller.MARGIN_TOP
            );
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

        for (const op of opsToUpdate) {
            // Update location of dram-write-sent-tile ticks
            if (op instanceof Op && op.dramWriteSent.length > 0) {
                function handleMouseOverSent(this: SVGGraphicsElement, d, line: Line) {
                    const text: string[] = [];
                    const index = dramWriteSentCycles.nodes().indexOf(this);
                    text.push(
                        '<tr>',
                        '<td id="field">' +
                            '<span style="color:black">' +
                            'Dram Write Tiles Sent' +
                            '</span>' +
                            '</td>',
                        '<br>',
                        `<td id="unit">` +
                            `<span style="color:black">` +
                            `Unit: ` +
                            `</span>` +
                            `<span style="color:blue">${line.unit}</span>` +
                            `</td>`,
                        '<br>',
                        // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                        // '<br>',
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

                const dramWriteSentCycles = opBars
                    .selectAll(`.dram-write-sent-op-id-${op.id}`)
                    .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('y1', bar_top_sent(op))
                    .attr('y2', bar_top_sent(op) + op.barHeight / 2)
                    .on('mouseover', handleMouseOverSent)
                    .on('mouseout', handleMouseOut);
            }
            // Update location of dram-write-tile-cleared ticks
            if (op instanceof Op && op.dramWriteCleared.length > 0) {
                function handleMouseOverCleared(this: SVGGraphicsElement, d, line: Line) {
                    const text: string[] = [];
                    const index = dramWriteClearedCycles.nodes().indexOf(this);
                    text.push(
                        '<tr>',
                        '<td id="field">' +
                            '<span style="color:black">' +
                            'Dram Write Tiles Cleared' +
                            '</span>' +
                            '</td>',
                        '<br>',
                        `<td id="unit">` +
                            `<span style="color:black">` +
                            `Unit: ` +
                            `</span>` +
                            `<span style="color:blue">${line.unit}</span>` +
                            `</td>`,
                        '<br>',
                        // '<td id="index">' + '<span style="color:black">' + "ID: " + '</span>' + '<span style="color:blue">' + d3.format(",")(index) + '</span>' + '</td>',
                        // '<br>',
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
                const dramWriteClearedCycles = opBars
                    .selectAll(`.dram-write-cleared-op-id-${op.id}`)
                    .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle))
                    .attr('y1', bar_top_cleared(op))
                    .attr('y2', bar_top_cleared(op) + op.barHeight / 2)
                    .on('mouseover', handleMouseOverCleared)
                    .on('mouseout', handleMouseOut);
            }
        }
    }

    updateWaitForTile(opBars: any, opsToUpdate: Array<Op | CoreOp>): void {
        const { d3Ref } = this;
        const { opColors } = this;
        const waitForTileRegex = /^wait-for-incoming-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
        const waitForFreeTileRegex = /^wait-for-free-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
        const bar_top_incoming = (op: CoreOp, waitForIncomingTileId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = waitForIncomingTileId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_free = (op: CoreOp, waitForFreeTileId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights =
                (op as CoreOp).waitForIncomingTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = waitForFreeTileId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights +
                PerfDumpD3Controller.MARGIN_TOP
            );
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
        for (const op of opsToUpdate) {
            if (op instanceof CoreOp && op.waitForIncomingTiles.size > 0) {
                const keys = [...op.waitForIncomingTiles.keys()];
                for (
                    let waitForIncomingTileId = 0;
                    waitForIncomingTileId < op.waitForIncomingTiles.size;
                    waitForIncomingTileId++
                ) {
                    const key = keys[waitForIncomingTileId];
                    function handleMouseOverIncoming(this: SVGGraphicsElement, d, rect: Rect) {
                        const text: string[] = [];
                        const index = waitForIncomingTile.nodes().indexOf(this);
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
                                `<span style="color:blue">${(op as CoreOp).loc.x}-${(op as CoreOp).loc.y}</span>` +
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
                                `<span style="color:blue">${d3.format(',')(rect.high - rect.leftBound)}</span>` +
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
                        .selectAll(`.coreOp-id-${op.id}-wait-for-incoming-tiles-id-${waitForIncomingTileId}`)
                        .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                        .attr('y', bar_top_incoming(op, waitForIncomingTileId))
                        .attr(
                            'width',
                            (rect: Rect) =>
                                this.currentXScale(rect.high - this.startCycle) -
                                this.currentXScale(rect.low - this.startCycle),
                        )
                        .attr('height', op.barHeight)
                        .on('mouseover', handleMouseOverIncoming)
                        .on('mouseout', handleMouseOutIncoming);
                }
            }
            if (op instanceof CoreOp && op.waitForFreeTiles.size > 0) {
                const keys = [...op.waitForFreeTiles.keys()];
                for (let waitForFreeTileId = 0; waitForFreeTileId < op.waitForFreeTiles.size; waitForFreeTileId++) {
                    const key = keys[waitForFreeTileId];
                    function handleMouseOverFree(this: SVGGraphicsElement, d, rect: Rect) {
                        const text: string[] = [];
                        const index = waitForFreeTile.nodes().indexOf(this);
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
                                `<span style="color:blue">${(op as CoreOp).loc.x}-${(op as CoreOp).loc.y}</span>` +
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
                                `<span style="color:blue">${d3.format(',')(rect.high - rect.leftBound)}</span>` +
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
                        .selectAll(`.coreOp-id-${op.id}-wait-for-free-tiles-id-${waitForFreeTileId}`)
                        .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                        .attr('y', bar_top_free(op, waitForFreeTileId))
                        .attr(
                            'width',
                            (rect: Rect) =>
                                this.currentXScale(rect.high - this.startCycle) -
                                this.currentXScale(rect.low - this.startCycle),
                        )
                        .attr('height', op.barHeight)
                        .on('mouseover', handleMouseOverFree)
                        .on('mouseout', handleMouseOutFree);
                }
            }
        }
    }

    updateTriscStallOnDram(opBars: any, opsToUpdate: Array<Op | CoreOp>): void {
        const { d3Ref } = this;
        const { opColors } = this;
        const triscStallOnDramRegex = /^trisc-stall-on-dram-perf-dump-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
        const bar_top_unpacker = (op: CoreOp, triscStallOnDramUnpackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = op.waitForIncomingTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = op.waitForFreeTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallUnpackerHeights =
                triscStallOnDramUnpackerId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                +prevFreeHeights +
                prevTriscStallUnpackerHeights +
                PerfDumpD3Controller.MARGIN_TOP
            );
        };

        const bar_top_packer = (op: CoreOp, triscStallOnDramPackerId: number): number => {
            const prevModelHeights =
                this.visProps.showModelNumbers && this.modelData && !op.outOfMemory ? op.barHeight : 0;
            const prevTriscHeight = PerfDumpD3Controller.MARGIN_TOP + op.barHeight;
            const prevIncomingHeights = op.waitForIncomingTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevFreeHeights = op.waitForFreeTiles.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallUnpackerHeights =
                op.triscStallOnDramUnpacker.size * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            const prevTriscStallPackerHeights =
                triscStallOnDramPackerId * (PerfDumpD3Controller.MARGIN_TOP + op.barHeight);
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                prevTriscHeight +
                prevModelHeights +
                prevIncomingHeights +
                prevFreeHeights +
                prevTriscStallUnpackerHeights +
                prevTriscStallPackerHeights +
                PerfDumpD3Controller.MARGIN_TOP
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
        for (const op of opsToUpdate) {
            if (op instanceof CoreOp && op.triscStallOnDramUnpacker.size > 0) {
                const keys = [...op.triscStallOnDramUnpacker.keys()];
                for (
                    let triscStallOnDramUnpackerId = 0;
                    triscStallOnDramUnpackerId < op.triscStallOnDramUnpacker.size;
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
                                `<span style="color:blue">${(op as CoreOp).loc.x}-${(op as CoreOp).loc.y}</span>` +
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
                                `<span style="color:blue">${d3.format(',')(rect.high - rect.leftBound)}</span>` +
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
                        .selectAll(`.coreOp-id-${op.id}-trisc-stall-on-dram-unpacker-${triscStallOnDramUnpackerId}`)
                        .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                        .attr('y', bar_top_unpacker(op, triscStallOnDramUnpackerId))
                        .attr(
                            'width',
                            (rect: Rect) =>
                                this.currentXScale(rect.high - this.startCycle) -
                                this.currentXScale(rect.low - this.startCycle),
                        )
                        .attr('height', op.barHeight)
                        .on('mouseover', handleMouseOverUnpacker)
                        .on('mouseout', handleMouseOutUnpacker);
                }
            }
            if (op instanceof CoreOp && op.triscStallOnDramPacker.size > 0) {
                const keys = [...op.triscStallOnDramPacker.keys()];
                for (
                    let triscStallOnDramPackerId = 0;
                    triscStallOnDramPackerId < op.triscStallOnDramPacker.size;
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
                                `<span style="color:blue">${(op as CoreOp).loc.x}-${(op as CoreOp).loc.y}</span>` +
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
                                `<span style="color:blue">${d3.format(',')(rect.high - rect.leftBound)}</span>` +
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
                        .selectAll(`.coreOp-id-${op.id}-trisc-stall-on-dram-packer-${triscStallOnDramPackerId}`)
                        .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
                        .attr('y', bar_top_packer(op, triscStallOnDramPackerId))
                        .attr(
                            'width',
                            (rect: Rect) =>
                                this.currentXScale(rect.high - this.startCycle) -
                                this.currentXScale(rect.low - this.startCycle),
                        )
                        .attr('height', op.barHeight)
                        .on('mouseover', handleMouseOverPacker)
                        .on('mouseout', handleMouseOutPacker);
                }
            }
        }
    }

    /** Recalculate coordinates of lines and bars */
    updateDeviceBars(opBars: any, opsToUpdate: Array<Op | CoreOp>): void {
        console.log('updateDeviceBars');
        if (this.visProps.showAllDramReads) {
            this.updateDramReadTicks(opBars, opsToUpdate);
        }
        if (this.visProps.showAllDramWrites) {
            this.updateDramWriteTicks(opBars, opsToUpdate);
        }
        if (this.showTrisc) {
            this.updateTriscBars(opBars);
            this.updateWaitForTile(opBars, opsToUpdate);
            this.updateTriscStallOnDram(opBars, opsToUpdate);
        }
        this.updateDeviceBarSeparators();

        opBars
            .selectAll('.g-ops')
            .attr(
                'transform',
                (op: Op | CoreOp) =>
                    `translate(${0},${this.hostEventOpIndexMap[op.fullName] * this.BAR_REGION_HEIGHT})`,
            );
    }

    updateDeviceBarSeparators(): void {
        for (let i = 0; i < this.opsToPlot.length; i++) {
            let folderPathChange = false;
            const line_top = (): number => {
                const padding = this.BAR_REGION_HEIGHT / 150;
                return PerfDumpD3Controller.MARGIN_SHIFT_DOWN + this.BAR_REGION_HEIGHT - padding;
            };
            if (this.folderPaths.length > 1 && i < this.opsToPlot.length - 1) {
                if (
                    this.opsToPlot[i + 1].graphId != this.opsToPlot[i].graphId ||
                    this.opsToPlot[i + 1].folderPath != this.opsToPlot[i].folderPath ||
                    this.opsToPlot[i + 1].epoch != this.opsToPlot[i].epoch
                ) {
                    folderPathChange = true;
                }
            }
            const line = this.opBars
                .selectAll(`.separator-${this.opsToPlot[i].id}`)
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

    updateTriscBarsOnAxisChange(): void {
        const bar_low = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.low! - this.startCycle) : 0;
        };
        const bar_medLow = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.medLow! - this.startCycle) : 0;
        };

        const bar_high = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.high! - this.startCycle) : 0;
        };

        const bar_medHigh = (op: Op | CoreOp): number => {
            return !op.outOfMemory ? this.currentXScale(op.bounds.medHigh! - this.startCycle) : 0;
        };
        // End of model and modelprop bars (These bars start at medLow of silicon data bars)
        const bar_model = (op: Op | CoreOp): number => {
            return !op.outOfMemory && isNumber(op.modelCycles)
                ? this.currentXScale(op.bounds.medLow! - this.startCycle + op.modelCycles!)
                : 0;
        };

        const bar_modelProp = (op: Op | CoreOp): number => {
            return !op.outOfMemory && isNumber(op.modelCyclesProp)
                ? this.currentXScale(op.bounds.medLow! - this.startCycle + op.modelCyclesProp!)
                : 0;
        };

        this.opBars.selectAll('.pd-candle-vs').attr('x1', bar_low).attr('x2', bar_low);

        this.opBars.selectAll('.pd-candle-ve').attr('x1', bar_high).attr('x2', bar_high);

        this.opBars.selectAll('.pd-candle-hs').attr('x1', bar_low).attr('x2', bar_medLow);

        this.opBars.selectAll('.pd-candle-he').attr('x1', bar_medHigh).attr('x2', bar_high);

        this.opBars
            .selectAll('.pd-candle-bar')
            .attr('x', bar_medLow)
            .attr('width', (op: Op | CoreOp) => bar_medHigh(op) - bar_medLow(op));

        this.opBars
            .selectAll('.pd-candle-bar-model')
            .attr('x', bar_medLow)
            .attr('width', (op: Op | CoreOp) =>
                !op.outOfMemory && isNumber(op.modelCycles) ? bar_model(op) - bar_medLow(op) : 0,
            );

        this.opBars
            .selectAll('.pd-candle-bar-model-prop')
            .attr('x', bar_medLow)
            .attr('width', (op: Op | CoreOp) =>
                !op.outOfMemory && isNumber(op.modelCyclesProp) ? bar_modelProp(op) - bar_medLow(op) : 0,
            );
    }

    updateDeviceBarsOnAxisChange(): void {
        this.opBars
            .selectAll('.perf-dump-plotted-line-element')
            .attr('x1', (line: Line) => this.currentXScale(line.value - this.startCycle))
            .attr('x2', (line: Line) => this.currentXScale(line.value - this.startCycle));

        this.opBars
            .selectAll('.perf-dump-rect-element')
            .attr('x', (rect: Rect) => this.currentXScale(rect.low - this.startCycle))
            .attr(
                'width',
                (rect: Rect) =>
                    this.currentXScale(rect.high - this.startCycle) - this.currentXScale(rect.low - this.startCycle),
            );

        this.updateTriscBarsOnAxisChange();
    }

    // creates html containers and text for op names.
    createDeviceOpNames(): void {
        this.opNames
            .selectAll('.g-op-name')
            .data(this.opsToPlot)
            .enter()
            .append('g')
            .attr('class', 'g-op-name')
            .append('text')
            .attr('stroke', 'none')
            .text((op: Op | CoreOp) => (op.outOfMemory ? `out-of-memory-${op.name}` : op.name));

        const folderPathShifts: number[] = [];
        if (this.folderPaths.length > 1) {
            for (let i = 0; i < this.opsToPlot.length - 1; i++) {
                if (
                    this.opsToPlot[i + 1].graphId != this.opsToPlot[i].graphId ||
                    this.opsToPlot[i + 1].folderPath != this.opsToPlot[i].folderPath ||
                    this.opsToPlot[i + 1].epoch != this.opsToPlot[i].epoch
                ) {
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
            .selectAll('.g-op-name')
            .append('line')
            .attr('class', 'text-separator')
            .attr('stroke', textLineColor)
            .attr('stroke-width', 1)
            .style('opacity', textLineOpacity);
    }

    // sets x,y location of op names as well as binds them with event listeners.
    updateDeviceOpNames(): void {
        const textPaddingLeft = 10;
        const offsetY = this.hostEventsToPlot.length;
        const expandOp = (name: string): void => {
            let op;
            for (const folderPath of Object.keys(this.ops)) {
                op = this.ops[folderPath].find((element: Op) => element.fullName === name);
                if (op != undefined) {
                    break;
                }
            }
            if (op == undefined) {
                console.error('Perf dump: unexpected undefined when expanding op.');
                return;
            }
            op.expanded = true;
            const domain = this.currentXScale.domain();
            const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
            this.plotSvg.selectAll('#cycleIndicator').remove();
            d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
            this.plotSvg.selectAll('#timePoint').remove();
            this.filterOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpSelect(op.coreOps);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        };

        const collapseOp = (name: string): void => {
            let op;
            for (const folderPath of Object.keys(this.ops)) {
                op = this.ops[folderPath].find((element: Op) => element.fullName === name);
                if (op != undefined) {
                    break;
                }
            }
            if (op == undefined) {
                console.error('Perf dump: unexpected undefined when collapsing op.');
                return;
            }
            op.expanded = false;
            const domain = this.currentXScale.domain();
            const indicatorValues = this.plotSvg.selectAll('#cycleIndicator').data();
            this.plotSvg.selectAll('#cycleIndicator').remove();
            d3.select(this.d3Ref).selectAll('#tooltipTimeDiff').remove();
            this.plotSvg.selectAll('#timePoint').remove();
            this.filterOpsAndHostEvents();
            this.calculateFlexableBounds();
            this.calculateDrawingParameters();
            this.updatePlotHeight();
            this.reDrawOnOpDeselect(op.coreOps);
            this.zoomToDomain(domain);
            indicatorValues.forEach((i: Indicator) => this.addIndicatorToXscale(i.value));
        };

        const showFeederDrainer = (op: Op): void => {
            this.opNames.selectAll('.feederRect').remove();
            this.opNames.selectAll('.drainerRect').remove();
            if (this.showFeederDrainerOp && this.showFeederDrainerOp.name == op.name) {
                this.showFeederDrainerOp = undefined;
            } else if (!this.showFeederDrainerOp || this.showFeederDrainerOp.name != op.name) {
                this.showFeederDrainerOp = op;
            }
            this.updateDeviceOpNames();
        };

        const bar_text_y = (index: number): number => {
            return (
                PerfDumpD3Controller.MARGIN_SHIFT_DOWN +
                (index + offsetY) * this.BAR_REGION_HEIGHT +
                (1 / 2) * this.BAR_REGION_HEIGHT
            );
        };

        const bar_text_line_y = (_: any, index: number): number => {
            return this.bar_text_line_y(_, index + offsetY);
        };

        const opsToPlot = this.opsToPlot.map((op: Op | CoreOp) => op.fullName);
        this.opNames
            .selectAll('.g-op-name')
            .selectAll('text')
            .attr('x', (op: Op | CoreOp) => (op instanceof Op ? textPaddingLeft : 2 * textPaddingLeft))
            .attr('y', function (this: SVGGraphicsElement, op: Op | CoreOp): number {
                const textHeight = d3.select(this).node().getBBox().height;
                // console.log("TEXT HEIGHT: ", textHeight / 2.5)
                const y = bar_text_y(opsToPlot.indexOf(op.fullName)) + textHeight / 4;
                return y;
            })
            .attr('fill', (op: Op | CoreOp) => (op.outOfMemory ? 'red' : op instanceof Op ? 'white' : '#33ccff'))
            .attr('font-weight', (op: Op | CoreOp) =>
                this.showFeederDrainerOp && op.name == this.showFeederDrainerOp.name ? 900 : 400,
            )
            .attr('font-size', () => {
                if (this.visProps.barRegionHeight > 30) {
                    return '0.85em';
                }
                if (this.visProps.barRegionHeight > 15) {
                    return '0.7em';
                }
                return '0.5em';
            })
            .style('cursor', (op: Op | CoreOp) => (op instanceof Op ? 'pointer' : 'default'))
            // .style("text-decoration", (op) => (this.showFeederDrainerOp && op.name == this.showFeederDrainerOp.name) ? "underline" : "none")
            .on('click', function (d, op: Op | CoreOp) {
                if (op instanceof CoreOp) {
                    return;
                }
                if (op.expanded) {
                    collapseOp(op.fullName);
                } else if (!op.expanded) {
                    expandOp(op.fullName);
                }
            })
            .on('contextmenu', function (d, op) {
                if (op instanceof CoreOp) {
                    return;
                }
                d.preventDefault();
                showFeederDrainer(op);
            })
            .on('mouseover', function (this: SVGGraphicsElement, d, op) {
                if (op instanceof CoreOp) {
                    return;
                }
                d3.select(this).attr('fill', 'orange');
            })
            .on('mouseout', function (this: SVGGraphicsElement, d, op) {
                if (op instanceof CoreOp) {
                    return;
                }
                d3.select(this).attr('fill', op.outOfMemory ? 'red' : 'white');
            });

        this.opNames
            .selectAll('.text-separator')
            .attr('x1', 0)
            .attr('x2', PerfDumpD3Controller.MARGIN_LEFT)
            .attr('y1', bar_text_line_y)
            .attr('y2', bar_text_line_y);

        // show feeder drainer op names
        if (this.showFeederDrainerOp) {
            const { feeders } = this.showFeederDrainerOp;
            const { drainers } = this.showFeederDrainerOp;
            const feederIds: number[] = [];
            const drainerIds: number[] = [];

            for (let i = 0; i < this.opsToPlot.length && feederIds.length < feeders.length; i++) {
                if (feeders.includes(this.opsToPlot[i].name)) {
                    feederIds.push(i);
                }
            }

            for (let i = 0; i < this.opsToPlot.length && drainerIds.length < drainers.length; i++) {
                if (drainers.includes(this.opsToPlot[i].name)) {
                    drainerIds.push(i);
                }
            }

            const feederColor = '#ccffff';
            const drainerColor = '#e5ccff';
            for (const id of feederIds) {
                this.opNames
                    .append('rect')
                    .attr('class', 'feederRect')
                    .attr('x', 0)
                    .attr('y', bar_text_line_y(this.showFeederDrainerOp, id - 1))
                    .attr('width', PerfDumpD3Controller.MARGIN_LEFT)
                    .attr('height', this.BAR_REGION_HEIGHT)
                    .attr('pointer-events', 'none')
                    .attr('fill', feederColor)
                    .style('opacity', 0.2);
            }

            for (const id of drainerIds) {
                this.opNames
                    .append('rect')
                    .attr('class', 'drainerRect')
                    .attr('x', 0)
                    .attr('y', bar_text_line_y(this.showFeederDrainerOp, id - 1))
                    .attr('pointer-events', 'none')
                    .attr('width', PerfDumpD3Controller.MARGIN_LEFT)
                    .attr('height', this.BAR_REGION_HEIGHT)
                    .attr('fill', drainerColor)
                    .style('opacity', 0.2);
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
            .attr('y2', this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN);

        this.plotSvg
            .selectAll('#timePoint')
            .attr('x', (indicator: Indicator) => this.currentXScale(indicator.value))
            .text((indicator: Indicator) => d3.format(',')(indicator.value)); // Cycle displayed at the top

        // const bubble = d3.select("#tooltipTimeDiff");

        // if (!bubble.empty()) width = bubble.node().getBoundingClientRect().width;
        if (!indicators.empty() && indicators.nodes().length == 2) {
            const leftWidth = window.innerWidth - this.visProps.width + PerfDumpD3Controller.MARGIN_LEFT;
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
                    .attr('y1', PerfDumpD3Controller.MARGIN_SHIFT_DOWN)
                    .attr('y2', height + PerfDumpD3Controller.MARGIN_SHIFT_DOWN)
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
                    const indicators = d3.select(this).selectAll('#cycleIndicator').nodes();
                    const indicatorData = d3.select(this).selectAll('#cycleIndicator').data();
                    const leftWidth = window.innerWidth - visProps.width + PerfDumpD3Controller.MARGIN_LEFT;
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
            .attr('y1', PerfDumpD3Controller.MARGIN_SHIFT_DOWN)
            .attr('y2', this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN)
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
            const leftWidth = window.innerWidth - visProps.width + PerfDumpD3Controller.MARGIN_LEFT;
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

    // note: right click and zoom should be updated
    updatePlotHeight(): void {
        // resize d3 ref (white box)
        d3.select(this.d3Ref)
            .style(
                'min-height',
                this.setRefMinHeight ? `${this.visProps.height + PerfDumpD3Controller.MARGIN_SHIFT_DOWN}px` : `${0}px`,
            )
            .style('max-height', `${this.visProps.height + PerfDumpD3Controller.MARGIN_SHIFT_DOWN}px`);

        // resize svg
        this.svg
            .attr('height', this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM)
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM,
            ]);

        // resize plot svg
        this.plotSvg.attr(
            'height',
            this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM,
        );

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        // move x scale to the bottom of the plot
        this.xAxisg
            .attr('transform', `translate(${0},${this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        this.xAxisg.lower();

        this.plotSvg.select('.backgroundRect').attr('height', this.FULL_H);

        this.updateIndicators();
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
            .on('zoom', (ev: d3.D3ZoomEvent<d3.ZoomedElementBaseType, unknown>) => {
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

    // updatePlotDramReads(visProps: PerfDumpVisProps): void {
    //   this.visProps = visProps;
    //   // console.log("THIS.OPS: ", this.ops);
    //   for (const op of this.ops) {
    //     op.visProps = visProps;
    //     // console.log("MODEL CYCLES: ", op.modelCycles)
    //     // console.log("MODEL PROP CYCLES: ", op.modelCyclesProp)
    //   }
    //   this.calculateFlexableBounds();
    //   this.calculateDrawingParameters();
    //   this.xScale
    //     .domain([0, this.endCycle - this.startCycle]);

    //   this.currentXScale = this.xScale;

    //   this.xAxis = d3.axisBottom(this.xScale)
    //     .tickSize(-this.FULL_H);

    //   this.xAxisg
    //     .call(this.xAxis);

    //   this.xAxisg.lower();

    //   this.updateHostBars();
    //   if (this.visProps.showAllDramReads) {
    //     const candlestick = this.opBars.selectAll("#g-ops"),
    //     opsToPlot = this.opsToPlot,
    //     opColors = this.opColors;

    //     candlestick.each(function (this: any, _, i) {
    //       if (opsToPlot[i] instanceof Op && (opsToPlot[i] as Op).dramReadIssued.length > 0) {
    //         d3.select(this)
    //           .selectAll(".dram-read-issued-op-id-" + i)
    //           .data((op: Op) => op.dramReadIssued)
    //           .enter()
    //           .append("line")
    //           .attr("class", "dram-read-issued-op-id-" + i + " " + "perf-dump-plotted-line-element")
    //           .attr("id", "dram-read-issued")
    //           .attr("stroke", opColors["dram_read_issued"])
    //           .attr("stroke-width", 2)
    //           .style("opacity", 0)
    //           .style("shape-rendering", "optimizeSpeed")
    //           .style("vector-effect", "non-scaling-stroke");
    //       }

    //       if (opsToPlot[i] instanceof Op && (opsToPlot[i] as Op).dramReadFlushed.length > 0) {
    //         d3.select(this)
    //           .selectAll(".dram-read-flushed-op-id" + i)
    //           .data((op: Op) => op.dramReadFlushed)
    //           .enter()
    //           .append("line")
    //           .attr("class", "dram-read-flushed-op-id-" + i + " " + "perf-dump-plotted-line-element")
    //           .attr("id", "dram-read-flushed")
    //           .attr("stroke", opColors["dram_read_flushed"])
    //           .attr("stroke-width", 2)
    //           .style("opacity", 0)
    //           .style("shape-rendering", "optimizeSpeed")
    //           .style("vector-effect", "non-scaling-stroke");
    //       }
    //     });
    //     this.updateDramReadTicks();
    //   }
    //   else if (!this.visProps.showAllDramReads) {
    //     this.opBars
    //       .selectAll("#dram-read-issued")
    //       .remove()
    //     this.opBars
    //       .selectAll("#dram-read-flushed")
    //       .remove();
    //   }
    //   if (this.visProps.showAllDramWrites) this.updateDramWriteTicks();
    //   if (this.showTrisc) {
    //     this.updateTriscBars();
    //     this.updateWaitForTile();
    //   }
    //   this.zoomScale = 1;

    //   this.zoom = d3.zoom()
    //     //.x(x)
    //     .scaleExtent([1, 17000])
    //     .on("zoom", (ev) => {
    //       this.zoomed(ev.transform);
    //     });

    //   this.zoom.translateExtent([[0, 0], [this.visProps.width, this.visProps.height]]);
    //   this.plotSvg
    //     .call(this.zoom);

    //   // reset zoom transform, update bars to new x axis, and update region zoom x scale
    //   this.resetZoom();

    // }

    // updateOnExpand(index: number): void {
    //   const bar_low = (op: Op | CoreOp): number => {
    //     return !op.outOfMemory ? this.currentXScale(op.bounds.low! - this.startCycle) : 0;
    //   };
    //   const bar_medLow = (op: Op | CoreOp): number => {
    //     return !op.outOfMemory ? this.currentXScale(op.bounds.medLow! - this.startCycle) : 0;
    //   };

    //   const bar_high = (op: Op | CoreOp): number => {
    //     return !op.outOfMemory ? this.currentXScale(op.bounds.high! - this.startCycle) : 0;
    //   };

    //   const bar_medHigh = (op: Op | CoreOp): number => {
    //     return !op.outOfMemory ? this.currentXScale(op.bounds.medHigh! - this.startCycle) : 0;
    //   };
    //   // End of model and modelprop bars (These bars start at medLow of silicon data bars)
    //   const bar_model = (op: Op | CoreOp): number => {
    //     return !op.outOfMemory && isNumber(op.modelCycles) ? this.currentXScale(op.bounds.medLow! - this.startCycle + op.modelCycles!) : 0;
    //   };

    //   const bar_modelProp = (op: Op | CoreOp): number => {
    //     return !op.outOfMemory && isNumber(op.modelCyclesProp) ? this.currentXScale(op.bounds.medLow! - this.startCycle + op.modelCyclesProp!) : 0;
    //   };

    //   const coreOps = (this.opsToPlot[index] as Op).coreOps;
    //   const shift = coreOps.length;
    //   const opsToShift = this.opsToPlot.slice(index + 1);
    //   coreOps.forEach((op: CoreOp) => op.barHeight = this.BAR_REGION_HEIGHT * op.getBarHeightRatio());
    //   this.opsToPlot.splice(index + 1, 0, ...coreOps);

    //   this.xScale
    //     .domain([0, this.endCycle - this.startCycle]);

    //   this.currentXScale = this.xScale;

    //   this.xAxis = d3.axisBottom(this.xScale)
    //     .tickSize(-this.FULL_H);

    //   this.xAxisg
    //     .call(this.xAxis);

    //   this.xAxisg.lower();

    //   this.updateHostBars();

    // }

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
        if (this.opsToPlot.some((op: Op | CoreOp) => op instanceof CoreOp)) {
            fieldNames.push('Wait For Incoming Tiles', 'Wait For Free Tiles');
            fieldColors.push(this.opColors.wait_for_tile, this.opColors.wait_for_free_tile);
        }

        // console.log(fieldNames)
        this.legend = this.svg
            .append('svg')
            .attr('class', 'legend-container')
            .attr('x', PerfDumpD3Controller.MARGIN_LEFT / 10)
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
                        .attr('y1', PerfDumpD3Controller.MARGIN_SHIFT_DOWN)
                        .attr('y2', FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN)
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

    /** Main first-time draw function */
    draw(): void {
        d3.select(this.d3Ref).selectAll('*').remove();
        d3.select(this.d3Ref)
            .style('display', this.display ? 'inline-block' : 'none')
            .style('overflow-y', 'scroll')
            .style('border', 'solid')
            .style('border-width', '2px')
            .style('border-radius', '5px')
            .style('border-color', 'white')
            .style(
                'min-height',
                this.setRefMinHeight ? `${this.visProps.height + PerfDumpD3Controller.MARGIN_SHIFT_DOWN}px` : `${0}px`,
            )
            .style('max-height', `${this.visProps.height + PerfDumpD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-width', `${this.visProps.width + PerfDumpD3Controller.MARGIN_RIGHT}px`);

        this.svg = d3
            .select(this.d3Ref)
            .append('svg')
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM)
            .attr('class', 'perf-dump-d3')
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM,
            ])
            .style('shape-rendering', 'optimizeSpeed');

        this.plotSvg = this.svg
            .append('svg')
            .attr('x', PerfDumpD3Controller.MARGIN_LEFT)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM)
            .attr('pointer-events', 'all')
            .attr('class', 'perf-dump-d3-plot')
            .style('shape-rendering', 'optimizeSpeed');

        // // Keep bars and lines from going out of the display box
        // this.plotSvg.append("defs")
        //   .append("clipPath")
        //   .attr("id", "clipper")
        //   .append("rect")
        //   .attr("x", 0)
        //   .attr("y", 0)
        //   .attr("width", this.FULL_W)
        //   .attr("height", this.FULL_H + PerfDumpD3.MARGIN_SHIFT_DOWN + PerfDumpD3.MARGIN_BOTTOM);

        this.xScale = d3
            .scaleLinear()
            .domain([0, this.endCycle - this.startCycle])
            .range([0, this.FULL_W]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg = this.plotSvg
            .append('g')
            .attr('class', 'x_axis')
            .attr('transform', `translate(${0},${this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        // const g = this.plotSvg.append("g").attr("class", "backgroundg")
        // Darker background behind the bars
        this.plotSvg
            .append('rect')
            .attr('x', 0)
            .attr('y', PerfDumpD3Controller.MARGIN_SHIFT_DOWN)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H)
            .attr('stroke', 'white')
            .attr('stroke-width', '1px')
            .attr('fill', 'rgba(16, 22, 26, 0.3)')
            .attr('pointer-events', 'all')
            .attr('class', 'backgroundRect');

        // this.counter = 0;
        // let counter = this.counter
        // d3.select(this.d3Ref)
        //   .attr("tabindex", "0")
        // d3.select(this.d3Ref).on("keydown", function(d) {
        //   console.log("KEY DOWN")
        // })
        // .on("keyup", function(d) {
        //   // console.log("KEY UP", counter)
        //   // console.log(d)
        // })

        this.opBars = this.plotSvg.append('g').attr('id', 'g-pd-opbars');
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

        this.plotSvg.call(this.zoom.transform, d3.zoomIdentity);

        this.updateHostBars(this.opBars, this.hostEventsToPlot);
        this.updateDeviceBars(this.opBars, this.opsToPlot);
        this.createHostEventNames();
        this.updateHostEventNames();
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
        this.updateIndicators();
        this.drawLegend();
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
                    `translate(${0},${this.hostEventOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
        this.opBars
            .selectAll('.g-ops')
            .attr(
                'transform',
                (op: Op | CoreOp) =>
                    `translate(${0},${this.hostEventOpIndexMap[op.fullName] * this.BAR_REGION_HEIGHT})`,
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
                    `translate(${0},${this.hostEventOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
            );
        this.opBars
            .selectAll('.g-ops')
            .attr(
                'transform',
                (op: Op | CoreOp) =>
                    `translate(${0},${this.hostEventOpIndexMap[op.fullName] * this.BAR_REGION_HEIGHT})`,
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
    reDrawOnOpDeselect(opsToRemoveFromPlot: Array<Op | CoreOp>): void {
        for (const op of opsToRemoveFromPlot) {
            this.opBars.selectAll(`.g-op-${op.id}`).remove();
            if (op instanceof Op && op.expanded) {
                for (const coreOp of op.coreOps) {
                    this.opBars.selectAll(`.g-op-${coreOp.id}`).remove();
                }
            }
        }
        // reset the domain of x and apply the new scale to the bars
        this.updateXScaleDomainAndApplyToBars();
        // move the bars to the correct rows
        this.opBars
            .selectAll('.g-ops')
            .attr(
                'transform',
                (op: Op | CoreOp) =>
                    `translate(${0},${this.hostEventOpIndexMap[op.fullName] * this.BAR_REGION_HEIGHT})`,
            );
        // re draw horizontal lines so that they are the correct color
        this.updateDeviceBarSeparators();
        // move op names to correct rows
        this.opNames.selectAll('.g-op-name').remove();
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
    }

    reDrawOnOpSelect(newOpsToPlot: Array<Op | CoreOp>): void {
        console.log('reDrawOnOpSelect');
        const newOpRegions = this.opBars
            .selectAll('.placeholder-class')
            .data(newOpsToPlot)
            .enter()
            .append('g')
            .attr('class', (op: Op | CoreOp) => `g-ops g-op-${op.id}`);

        // draw the newly selected ops
        this.createDeviceBars(newOpRegions);
        // update y coordinate and mouse over listeners for the newly selected ops
        this.updateDeviceBars(newOpRegions, newOpsToPlot);

        // reset the domain of x and apply the new scale to the bars
        this.updateXScaleDomainAndApplyToBars();
        // move the bars to the correct rows
        this.opBars
            .selectAll('.g-ops')
            .attr(
                'transform',
                (op: Op | CoreOp) =>
                    `translate(${0},${this.hostEventOpIndexMap[op.fullName] * this.BAR_REGION_HEIGHT})`,
            );

        // move op names to correct rows
        this.opNames.selectAll('.g-op-name').remove();
        this.createDeviceOpNames();
        this.updateDeviceOpNames();
    }

    redrawOnResize(): void {
        this.resetZoom();
        d3.select(this.d3Ref)
            .style('min-height', `${this.visProps.height + PerfDumpD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-height', `${this.visProps.height + PerfDumpD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('max-width', `${this.visProps.width + PerfDumpD3Controller.MARGIN_RIGHT}px`);

        this.svg
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM)
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM,
            ]);

        this.plotSvg
            .attr('height', this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN + PerfDumpD3Controller.MARGIN_BOTTOM)
            .attr('width', this.FULL_W);

        this.xScale.range([0, this.FULL_W]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg
            .attr('transform', `translate(${0},${this.FULL_H + PerfDumpD3Controller.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        this.xAxisg.lower();

        this.plotSvg.select('.backgroundRect').attr('height', this.FULL_H).attr('width', this.FULL_W);

        this.plotSvg.selectAll('#plot-separator').attr('x2', this.FULL_W);

        this.updateDeviceBarsOnAxisChange();
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

    getNumBars(): number {
        return this.svg.selectAll('*').nodes().length;
    }

    // Delete and undo everything
    close(): void {
        console.log('Closing perf dump d3');
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

    zoomed(transform: d3.ZoomTransform): void {
        this.zoomScale = transform.k;
        // eliminate zooming in the y direction
        (transform.y as number) = 0;
        // clamp x tranform to the width of the plot
        (transform.x as number) = Math.max(transform.x, (1 - transform.k) * this.FULL_W);
        const new_x_scale = transform.rescaleX(this.xScale);

        this.xAxisg.call(this.xAxis.scale(new_x_scale));

        this.currentXScale = new_x_scale;
        // this.showHost ? this.updateHostBarsOnAxisChange() : this.updateDeviceBarsOnAxisChange();
        // this.updateZoomRightClickDrag();

        // console.log("Tranform to string: ", transform.toString().replace(/scale\((.*?)\)/, "scale($1, 1)").replace(/translate\((.*?)\)/, `translate(${transform.x}, ${5000})`))

        this.opBars.selectAll('.g-ops').attr('transform', (op: Op | CoreOp) => {
            return transform
                .toString()
                .replace(
                    /translate\((.*?)\)/,
                    `translate(${transform.x}, ${this.hostEventOpIndexMap[op.fullName] * this.BAR_REGION_HEIGHT})`,
                )
                .replace(/scale\((.*?)\)/, 'scale($1, 1)');
        });

        this.opBars.selectAll('.g-host-events').attr('transform', (event: HostEvent) => {
            return transform
                .toString()
                .replace(
                    /translate\((.*?)\)/,
                    `translate(${transform.x}, ${this.hostEventOpIndexMap[event.fullName] * this.BAR_REGION_HEIGHT})`,
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
        return this.opsToPlot.length + this.hostEventsToPlot.length;
    }
}
