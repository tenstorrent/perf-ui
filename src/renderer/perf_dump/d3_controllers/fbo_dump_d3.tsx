// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

/**
 * D3 portion (visualization) of the ncrisc dump
 */

/* eslint no-unused-vars: [ "warn", { "argsIgnorePattern": "_" } ] */
/* eslint-disable @typescript-eslint/ban-types */
import * as d3 from 'd3';
import _ from 'lodash';
import { PerfDumpVisProps } from '../perf_utils';
// import { ZoomEvent } from "d3-zoom";

// Box:   [========]
//       low      high

interface Box {
    low: number;
    high: number;
}

interface Coord {
    x: number;
    y: number;
}

class Epoch {
    fbo: string;

    batch: string;

    minibatch: string;

    microbatch: string;

    epoch: number;

    // startTimes: number[];
    // endTimes: number[];
    earliestStart: number;

    latestEnd: number;

    row: number;

    barHeight: number;

    box: Box;

    constructor(fbo: string, batch: string, minibatch: string, microbatch: string, epoch: number, row: number) {
        this.fbo = fbo;
        this.batch = batch;
        this.minibatch = minibatch;
        this.microbatch = microbatch;
        this.epoch = epoch;
        this.row = row;
        this.earliestStart = Number.POSITIVE_INFINITY;
        this.latestEnd = Number.NEGATIVE_INFINITY;
    }
    // getEarliestStart(): number {
    //   this.earliestStart = (this.startTimes.length > 0 && this.endTimes.length > 0) ? Math.min(...this.startTimes) : 0;
    //   return this.earliestStart;
    // }

    // getLatestEnd(): number {
    //   this.latestEnd = (this.startTimes.length > 0 && this.endTimes.length > 0) ? Math.max(...this.endTimes) : 0;
    //   return this.latestEnd;
    // }
    setBox(): void {
        this.box = { low: this.earliestStart, high: this.latestEnd };
    }
}

export default class FboDumpD3 {
    d3Ref: HTMLDivElement;

    visProps: PerfDumpVisProps;

    data: Map<string, Map<number, Object>>; // perf dump data

    fboTable: Object;

    fboRowMap: Map<string, number>;

    perEpochData: Epoch[];

    allEpochs: number[];

    epochs: number[];

    epochEndTimes: Map<number, number>;

    totalRows: number;

    svg: any; // main SVG reference

    plotSvg: any; // SVG containing the bars and x axis, chile of main SVG reference

    legend: any;

    zoom: any; // reference to zoom transformer

    zoomScale: number;

    // references to various groups of elements that need to be moved, zoomed, etc.
    opBars: any; // "g" element holding op bars

    opNames: any; // "g" element holding op names

    xAxisg: any; // "g" element holding X axis

    opColors: Object;

    // Bounds of the chart, based on what was found in the data
    startCycle: number;

    endCycle: number;

    // original and current X scale
    xScale: CallableFunction;

    currentXScale: CallableFunction;

    xAxis: any;

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
        data: Map<string, Map<number, Object>>,
        fboLookUp: Object,
    ) {
        this.d3Ref = d3Ref;
        this.visProps = visProps;
        this.data = data;
        this.setFboTable(fboLookUp);
        this.processData();

        //
        // Draw
        //
        // Calculate parameters
        // console.log(this.startCycle);
        // console.log(this.endCycle);
        this.calculateDrawingParameters();

        // First-time draw
        this.draw();

        // // Set variable parmeters
        // this.update(visProps);
    }

    setFboTable(fboLookUp: Object): void {
        this.fboTable = {};
        const fbos = Object.keys(fboLookUp)
            .map((v) => v.toLowerCase())
            .filter((v) => ['forward', 'backward', 'optimizer'].includes(v));
        const order = ['forward', 'backward', 'optimizer'];
        fbos.sort((a: string, b: string) => {
            return order.indexOf(a) - order.indexOf(b);
        });
        for (const fbo of fbos) {
            this.fboTable[fbo] = {};
            const batches = Object.keys(fboLookUp[fbo]).map((v) => v.toLowerCase());
            batches.sort((a: string, b: string) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
            for (const batch of batches) {
                this.fboTable[fbo][batch] = {};
                const minibatches = Object.keys(fboLookUp[fbo][batch]).map((v) => v.toLowerCase());
                minibatches.sort((a: string, b: string) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
                for (const minibatch of minibatches) {
                    const microbatches = fboLookUp[fbo][batch][minibatch].map((v) => v.toLowerCase());
                    this.fboTable[fbo][batch][minibatch] = microbatches.sort(
                        (a: string, b: string) => Number(a.split('_').pop()) - Number(b.split('_').pop()),
                    );
                }
            }
        }
    }

    calculateDrawingParameters(): void {
        // TODO: Scale margin top as bars become crowded
        // Calculate drawing parameters
        FboDumpD3.MARGIN_TOP = this.visProps.barRegionHeight / 50;
        this.FULL_W = this.visProps.width - FboDumpD3.MARGIN_LEFT;
        this.BAR_REGION_HEIGHT = this.visProps.barRegionHeight;
        const panelHeight =
            this.visProps.height - FboDumpD3.MARGIN_TOP - FboDumpD3.MARGIN_BOTTOM - FboDumpD3.MARGIN_SHIFT_DOWN;
        this.perEpochData.forEach((epochDatum) => (epochDatum.barHeight = (2 / 3) * this.BAR_REGION_HEIGHT));
        this.FULL_H = Math.max(panelHeight, this.BAR_REGION_HEIGHT * this.totalRows);
    }

    update(visProps: PerfDumpVisProps): void {
        this.visProps = visProps;
        this.calculateDrawingParameters();
        this.draw();
        // const end = performance.now()
        // console.log("TIME DURATION: " + String(end - start))
    }

    resizeSVG(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        this.calculateDrawingParameters();
        this.draw();
    }

    parseFboBatchKey(key: string): [string, string, string | null, string | null] {
        const bRegex = /batch_(\d+)/;
        const mnbRegex = /mini_batch_(\d+)/;
        const mcbRegex = /micro_batch_(\d+)/;

        const fbo = key.split('_')[0];
        const batch = key.match(bRegex)[0];
        // miniBatch and microBatch do not exist in optimizer
        const miniBatch = key.match(mnbRegex) && key.match(mnbRegex)[0];
        const microBatch = key.match(mcbRegex) && key.match(mcbRegex)[0];
        return [fbo, batch, miniBatch, microBatch];
    }

    parseOpName(name: string): [string, number, number] {
        const regex = /^(\d+)-(\d+)-(\S+)$/;
        const m = name.match(regex);
        if (m === null) {
            // errors.push("CoreOp {op_name} has invalid name pattern.");
            console.error('CoreOp name parsing error: ', name, m);
            return ['', 0, 0];
        }

        return [m[3], parseInt(m[1]), parseInt(m[2])];
    }

    processData(): void {
        this.perEpochData = [];
        this.fboRowMap = new Map<string, number>();
        let fboStartRow = 0;
        let maxRow = 0;
        console.log('FBO TABLE', this.fboTable);
        for (const fbo of Object.keys(this.fboTable)) {
            const batches = Object.keys(this.fboTable[fbo]);
            fboStartRow = maxRow;
            this.fboRowMap.set(fbo, fboStartRow);
            for (const batch of batches) {
                if (fbo == 'optimizer') {
                    let epochRow = fboStartRow;
                    const fboBatchKey = [fbo, batch].join('_');
                    const multiEpochData = this.data.get(fboBatchKey);
                    for (const epoch of multiEpochData.keys()) {
                        const epochData = multiEpochData.get(epoch);
                        const newPerEpochDatum = new Epoch(fbo, batch, null, null, epoch, epochRow);
                        epochRow += 1;
                        maxRow = Math.max(maxRow, epochRow);
                        for (const op_data of Object.values(epochData)) {
                            newPerEpochDatum.earliestStart = Math.min(
                                newPerEpochDatum.earliestStart,
                                op_data.NCRISC.epoch.start,
                            );
                            newPerEpochDatum.latestEnd = Math.max(newPerEpochDatum.latestEnd, op_data.NCRISC.epoch.end);
                        }
                        if (
                            newPerEpochDatum.earliestStart !== Number.POSITIVE_INFINITY &&
                            newPerEpochDatum.latestEnd !== Number.NEGATIVE_INFINITY
                        ) {
                            this.perEpochData.push(newPerEpochDatum);
                        }
                    }
                    continue;
                }
                const minibatches = Object.keys(this.fboTable[fbo][batch]);
                for (const minibatch of minibatches) {
                    let epochRow = fboStartRow;
                    const microbatches = this.fboTable[fbo][batch][minibatch];
                    for (const microbatch of microbatches) {
                        const fboBatchKey = [fbo, batch, minibatch, microbatch].join('_');
                        const multiEpochData = this.data.get(fboBatchKey);
                        for (const epoch of multiEpochData.keys()) {
                            const epochData = multiEpochData.get(epoch);
                            const newPerEpochDatum = new Epoch(fbo, batch, minibatch, microbatch, epoch, epochRow);
                            epochRow += 1;
                            maxRow = Math.max(maxRow, epochRow);
                            for (const [op_name, op_data] of Object.entries(epochData)) {
                                if (
                                    this.parseOpName(op_name)[0] == '' ||
                                    op_data.NCRISC == undefined ||
                                    typeof op_data.NCRISC === 'string'
                                ) {
                                    continue;
                                }
                                if (op_data.NCRISC.epoch != undefined && !isNaN(parseInt(op_data.NCRISC.epoch.start))) {
                                    newPerEpochDatum.earliestStart = Math.min(
                                        newPerEpochDatum.earliestStart,
                                        op_data.NCRISC.epoch.start,
                                    );
                                }

                                if (op_data.NCRISC.epoch != undefined && !isNaN(parseInt(op_data.NCRISC.epoch.end))) {
                                    newPerEpochDatum.latestEnd = Math.max(
                                        newPerEpochDatum.latestEnd,
                                        op_data.NCRISC.epoch.end,
                                    );
                                }
                            }
                            if (
                                newPerEpochDatum.earliestStart != Number.POSITIVE_INFINITY &&
                                newPerEpochDatum.latestEnd != Number.NEGATIVE_INFINITY
                            ) {
                                this.perEpochData.push(newPerEpochDatum);
                            }
                        }
                    }
                }
            }
        }
        this.totalRows = maxRow;
        for (const epochDatum of this.perEpochData) {
            epochDatum.setBox();
        }
        console.log('PER EPOCH DATA:', this.perEpochData);
        console.log(this.totalRows);
        // for(let row = 0; row < this.totalRows; row++){
        //   const e = [];
        //   for(const epoch of this.perEpochData){
        //     if(epoch.row == row){
        //       e.push(epoch)
        //     }
        //   }
        //   console.log(e, "ROW: " + row)
        // }
        this.calculateFixedBounds();
    }

    // sortOps(): void {
    //   for(const coreOps of Object.values(this.allCoreOps)){
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
        const earlierEpoch = (startTime: number, e: Epoch): number => Math.min(startTime, e.earliestStart);

        const laterEpoch = (endTime: number, e: Epoch): number => Math.max(endTime, e.latestEnd);

        this.startCycle = this.perEpochData.reduce(earlierEpoch, this.perEpochData[0].earliestStart);
        this.endCycle = this.perEpochData.reduce(laterEpoch, this.perEpochData[0].latestEnd);
    }

    updateHorizontalLines(tDuration): void {
        for (let row = 0; row < this.totalRows; row++) {
            let fboChange = false;
            console.log(this.fboRowMap);
            for (const rowShift of this.fboRowMap.values()) {
                if (row == rowShift - 1) {
                    fboChange = true;
                }
            }
            const line_top = (): number => {
                const prevRegionHeights = row * this.BAR_REGION_HEIGHT;
                const padding = this.BAR_REGION_HEIGHT / 150;
                return FboDumpD3.MARGIN_SHIFT_DOWN + prevRegionHeights + this.BAR_REGION_HEIGHT - padding;
            };
            const line = d3
                .selectAll(`.separator-row-${row}`)
                .attr('x1', 0)
                .attr('x2', this.visProps.width)
                .attr('y1', line_top)
                .attr('y2', line_top)
                .attr('stroke', fboChange ? 'red' : 'white');

            line.lower();
        }
    }

    updateIndicators(tDuration = 60): void {
        const height = this.FULL_H;
        const { d3Ref } = this;
        const xScale = this.currentXScale;

        // redraw diff lines on update
        this.plotSvg
            .selectAll('#cycleIndicator')
            .transition()
            .duration(tDuration)
            .attr('x1', (timeStamp: number) => this.currentXScale(timeStamp))
            .attr('x2', (timeStamp: number) => this.currentXScale(timeStamp));
        this.plotSvg
            .selectAll('#timePoint')
            .transition()
            .duration(tDuration)
            .attr('x', (timeStamp: number) => this.currentXScale(timeStamp)); // Timestamp displayed at the top

        const bubble = d3.select('#tooltipTimeDiff');

        let width = 0;
        if (!bubble.empty()) {
            width = bubble.node().getBoundingClientRect().width;
        }

        d3.select('#tooltipTimeDiff')
            .transition()
            .duration(tDuration)
            .style(
                'left',
                (timeStamp: number) => `${FboDumpD3.MARGIN_LEFT + this.currentXScale(timeStamp) + width / 5}px`,
            ) // Diff bubble
            .style('opacity', (timeStamp: number) => {
                const x = FboDumpD3.MARGIN_LEFT + this.currentXScale(timeStamp) + width / 5;
                const v = x > FboDumpD3.MARGIN_LEFT && x < FboDumpD3.MARGIN_LEFT + this.FULL_W ? 0.9 : 0;
                return v;
            });

        this.plotSvg.on('click', function (d) {
            d.preventDefault();
            // alt + shift + click to delete all lines and numbers
            if (d.altKey && d.shiftKey) {
                d3.selectAll('#cycleIndicator').remove();
                d3.selectAll('#tooltipTimeDiff').remove();
                d3.selectAll('#timePoint').remove();
            }
            // shift + click to add line, max 2 lines allowed
            else if (d.shiftKey && d3.selectAll('#cycleIndicator').nodes().length < 2) {
                // relative coordinates
                const xy = d3.pointer(d);
                const timeStamp = Math.floor(xScale.invert(xy[0]));
                const newLine = d3
                    .select(this)
                    .append('line')
                    .data([timeStamp])
                    .attr('id', 'cycleIndicator')
                    .attr('x1', xy[0])
                    .attr('x2', xy[0])
                    .attr('y1', FboDumpD3.MARGIN_SHIFT_DOWN)
                    .attr('y2', height + FboDumpD3.MARGIN_SHIFT_DOWN)
                    .attr('stroke', '#ff0000')
                    .attr('stroke-width', 2)
                    .style('cursor', 'pointer')
                    .on('click', function (d, timeStamp) {
                        // alt + click to delete the line and number
                        if (d.altKey) {
                            d.stopPropagation();
                            d3.selectAll('#tooltipTimeDiff').remove();
                            d3.select(`.timePoint-${timeStamp}`).remove();
                            d3.select(this).remove();
                        }
                    });
                const newTime = d3
                    .select(this)
                    .append('text')
                    .data([timeStamp])
                    .attr('class', (timeStamp: number) => `timePoint-${timeStamp}`)
                    .attr('id', 'timePoint')
                    .attr('x', xy[0])
                    .attr('y', 15)
                    .text((timeStamp: number) => d3.format(',')(timeStamp))
                    .attr('fill', 'white')
                    .style('text-anchor', 'middle');

                newLine.raise();
                newTime.raise();

                // if we have two lines, show their difference
                if (d3.selectAll('#cycleIndicator').nodes().length === 2) {
                    const nodes = d3.selectAll('#timePoint').nodes();
                    const text1 = d3.select(nodes[0]).text();
                    const text2 = d3.select(nodes[1]).text();
                    const num1 = parseInt(text1.split(',').join(''));
                    const num2 = parseInt(text2.split(',').join(''));

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

                    const bubble = d3
                        .select('#tooltipTimeDiff')
                        .data([timeStamp])
                        .html(
                            `<tr>` +
                                `<td>` +
                                `<span style="color:black">` +
                                `Diff:` +
                                `</span>` +
                                `<span style="color:blue">${d3.format(',')(Math.abs(num1 - num2))}</span>` +
                                `</td>` +
                                `</tr>`,
                        )
                        .style('opacity', 0.9)
                        .style('top', `${d.pageY + 10}px`);

                    const { width } = bubble.node().getBoundingClientRect();
                    bubble.style('left', `${FboDumpD3.MARGIN_LEFT + xy[0] + width / 5}px`);
                } else {
                    d3.selectAll('#tooltipTimeDiff').remove();
                }
            }
        });
    }

    updateEpochBars(tDuration): void {
        const { d3Ref } = this;
        const { startCycle } = this;
        for (let row = 0; row < this.totalRows; row++) {
            const boxes = [];
            this.perEpochData.forEach((epochDatum) => {
                if (epochDatum.row == row) {
                    boxes.push(epochDatum);
                }
            });
            for (let c = 0; c < boxes.length; c++) {
                function handleMouseOver(d, e: Epoch) {
                    const capitalize = (s) => s && s[0].toUpperCase() + s.slice(1).toLowerCase();
                    const text = [];
                    text.push(
                        '<tr>',
                        `<td id="fbo">` + `<span style="color:blue">${capitalize(e.fbo)}</span>` + `</td>`,
                        '<br>',
                        `<td id="batch">` +
                            `<span style="color:black">` +
                            `Batch: ` +
                            `</span>` +
                            `<span style="color:blue">${e.batch.split('_').pop()}</span>` +
                            `</td>`,
                        '<br>',
                    );
                    if (e.minibatch) {
                        text.push(
                            `<td id="minibatch">` +
                                `<span style="color:black">` +
                                `MiniBatch: ` +
                                `</span>` +
                                `<span style="color:blue">${e.minibatch.split('_').pop()}</span>` +
                                `</td>`,
                            '<br>',
                        );
                    }
                    if (e.microbatch) {
                        text.push(
                            `<td id="microbatch">` +
                                `<span style="color:black">` +
                                `MicroBatch: ` +
                                `</span>` +
                                `<span style="color:blue">${e.microbatch.split('_').pop()}</span>` +
                                `</td>`,
                            '<br>',
                        );
                    }
                    text.push(
                        `<td id="epoch">` +
                            `<span style="color:black">` +
                            `Epoch: ` +
                            `</span>` +
                            `<span style="color:blue">${e.epoch}</span>` +
                            `</td>`,
                        '<br>',
                        `<td id="start">` +
                            `<span style="color:black">` +
                            `Start: ` +
                            `</span>` +
                            `<span style="color:blue">${d3.format(',')(e.box.low - startCycle)}</span>` +
                            `</td>`,
                        '<br>',
                        `<td id="end">` +
                            `<span style="color:black">` +
                            `End: ` +
                            `</span>` +
                            `<span style="color:blue">${d3.format(',')(e.box.high - startCycle)}</span>` +
                            `</td>`,
                        '<br>',
                        `<td id="diff">` +
                            `<span style="color:black">` +
                            `Diff: ` +
                            `</span>` +
                            `<span style="color:blue">${d3.format(',')(e.box.high - e.box.low)}</span>` +
                            `</td>`,
                        '</tr>',
                    );
                    d3.select(this).attr('fill', 'orange');
                    d3.select('#tooltip')
                        .html(text.join())
                        .style('opacity', 0.9)
                        .style('left', `${d.pageX + 10}px`)
                        .style('top', `${d.pageY + 10}px`);
                }
                function handleMouseOut() {
                    d3.select(this).attr('fill', 'green');
                    d3.selectAll('#tooltip').remove();
                    d3.select(d3Ref)
                        .append('div')
                        .attr('id', 'tooltip')
                        .attr('style', 'position: absolute;')
                        .style('background-color', 'white')
                        .style('border', 'solid')
                        .style('border-width', '2px')
                        .style('border-radius', '5px')
                        .style('padding', '5px')
                        .style('opacity', 0);
                }
                d3.selectAll(`.epoch-total-row-${row}-index-${c}`)
                    .transition()
                    .duration(tDuration)
                    .attr('x', (d: Epoch) => this.currentXScale(d.earliestStart - this.startCycle))
                    .attr('y', FboDumpD3.MARGIN_SHIFT_DOWN + row * this.BAR_REGION_HEIGHT + FboDumpD3.MARGIN_TOP)
                    .attr(
                        'width',
                        (d: Epoch) =>
                            this.currentXScale(d.latestEnd - this.startCycle) -
                            this.currentXScale(d.earliestStart - this.startCycle),
                    )
                    .attr('height', (d: Epoch) => d.barHeight)
                    .on('start', function () {
                        d3.select(this).on('mouseover', handleMouseOver).on('mouseout', handleMouseOut);
                    });
            }
        }
    }

    updateRegionZoom(): void {
        const { currentXScale } = this;
        const { FULL_H } = this;
        const { FULL_W } = this;
        const { plotSvg } = this;
        const updateScale = (newdomain) => {
            const [oldStart, oldEnd] = this.currentXScale.domain();

            // length of domains
            const oldRange = Math.abs(oldEnd - oldStart);
            const newRange = Math.abs(newdomain[1] - newdomain[0]);

            if (newRange <= 0) {
                return;
            }

            // zoom in the x scale domain
            const scaleIncrease = oldRange / newRange;
            this.plotSvg.call(this.zoom.scaleBy, scaleIncrease);

            // shift the xscale, number of pixels is determined by zoomed in xscale.
            // translateBy multiplies the shift by the transform scale (k), divide
            // shift prior to passing it in so we don't shift by k times extra.
            const xShift = -this.currentXScale(newdomain[0]);
            this.plotSvg.call(this.zoom.translateBy, xShift / this.zoomScale, 0);
            // this.updateBars(100);
            // this.updateRegionZoom();
        };

        const dragHandler = d3
            .drag()
            .on('drag', function (d) {
                // handle dragging

                if (d3.selectAll('#zoom-line').nodes().length == 0 || d.x < 0 || d.x > FULL_W) {
                    return;
                }
                d3.select('.zoom-line-1').attr('x1', d.x).attr('x2', d.x).style('opacity', 0.8);
            })
            .on('end', function () {
                const firstLineX = d3.select('.zoom-line-0').attr('x1');
                const secondLineX = d3.select('.zoom-line-1').attr('x1');

                const domainStart = currentXScale.invert(Math.min(firstLineX, secondLineX));
                const domainEnd = currentXScale.invert(Math.max(firstLineX, secondLineX));
                const newDomain = [domainStart, domainEnd];
                d3.selectAll('#zoom-line').remove();
                updateScale(newDomain);
            })
            .filter((event) => event.button == 2);

        // this.plotSvg
        //   .call(this.zoom)
        //   .on("mousedown.zoom", null);

        d3.select('.backgroundRect')
            .on('contextmenu', function (d) {
                d.preventDefault();
                console.log('IN MOUSE DOWN');
                if (d3.selectAll('#zoom-line').nodes().length >= 2) {
                    d3.selectAll('#zoom-line').remove();
                }

                const mousePointer = d3.pointer(d);
                for (let i = 0; i < 2; i++) {
                    const line = plotSvg
                        .append('line')
                        .attr('class', `zoom-line-${i}`)
                        .attr('id', 'zoom-line')
                        .attr('y1', FboDumpD3.MARGIN_SHIFT_DOWN)
                        .attr('y2', FULL_H + FboDumpD3.MARGIN_SHIFT_DOWN)
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
                d3.selectAll('#zoom-line').remove();
            });
    }

    updateBars(tDuration = 60): void {
        this.updateEpochBars(tDuration);
        this.updateHorizontalLines(tDuration);
        this.updateIndicators();
    }

    updateEpochBarsOnZoom(tDuration = 60): void {
        this.opBars
            .selectAll('#epoch-total')
            .transition()
            .duration(tDuration)
            .attr('x', (d: Epoch) => this.currentXScale(d.earliestStart - this.startCycle))
            .attr(
                'width',
                (d: Epoch) =>
                    this.currentXScale(d.latestEnd - this.startCycle) -
                    this.currentXScale(d.earliestStart - this.startCycle),
            );
    }

    updateBarsOnZoom(tDuration = 60): void {
        this.updateEpochBarsOnZoom(tDuration);
        this.updateIndicators();
    }

    updateOps(): void {
        const barTextY = (text: string) => {
            const fbo = text.toLowerCase();
            return (
                FboDumpD3.MARGIN_SHIFT_DOWN +
                (this.fboRowMap.get(fbo) + 0.5) * this.BAR_REGION_HEIGHT +
                FboDumpD3.MARGIN_TOP
            );
            // if(fbo == "forward"){
            //   return this.fboRowMap.get(fbo) / 2 * this.BAR_REGION_HEIGHT;
            // }
            // else if(fbo == "backward"){
            //   if([...this.fboRowMap.keys()].includes("forward")){
            //     return (this.fboRowMap.get("forward") + this.fboRowMap.get(fbo)) / 2 * this.BAR_REGION_HEIGHT;
            //   }
            //   else{
            //     return this.fboRowMap.get(fbo) / 2 * this.BAR_REGION_HEIGHT;
            //   }
            // }
            // else if(fbo == "optimizer"){
            //   if(this.fboRowMap.size == 3){
            //     return (this.fboRowMap.get("backward") + this.fboRowMap.get(fbo)) / 2 * this.BAR_REGION_HEIGHT;
            //   }
            //   else if(this.fboRowMap.size == 2){
            //     const keys = [...this.fboRowMap.keys()];
            //     const other = keys.filter(key => key != "optimizer").pop();
            //     return (this.fboRowMap.get(other) + this.fboRowMap.get(fbo)) / 2 * this.BAR_REGION_HEIGHT;
            //   }
            //   else{
            //     return this.fboRowMap.get(fbo) / 2 * this.BAR_REGION_HEIGHT;
            //   }
            // }
        };
        const textPaddingLeft = 10;
        this.opNames.selectAll('text').attr('x', textPaddingLeft).attr('y', barTextY);
    }

    /** Main first-time draw function */
    draw(): void {
        d3.select(this.d3Ref).selectAll('svg').remove();
        d3.select(this.d3Ref).selectAll('div').remove();
        d3.select(this.d3Ref)
            .style('max-height', `${this.visProps.height + FboDumpD3.MARGIN_SHIFT_DOWN}px`)
            .style('max-width', `${this.visProps.width + FboDumpD3.MARGIN_RIGHT}px`)
            .style('overflow', 'auto')
            .style('border', 'solid')
            .style('border-width', '2px')
            .style('border-radius', '5px');

        this.svg = d3
            .select(this.d3Ref)
            .append('svg')
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + FboDumpD3.MARGIN_SHIFT_DOWN + FboDumpD3.MARGIN_BOTTOM)
            .attr('class', 'perf-dump-d3')
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + FboDumpD3.MARGIN_SHIFT_DOWN + FboDumpD3.MARGIN_BOTTOM,
            ]);

        this.plotSvg = this.svg
            .append('svg')
            .attr('x', FboDumpD3.MARGIN_LEFT)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H + FboDumpD3.MARGIN_SHIFT_DOWN + FboDumpD3.MARGIN_BOTTOM);

        // Keep bars and lines from going out of the display box
        // this.svg.append("defs")
        //   .append("clipPath")
        //   .attr("id", "clipper")
        //   .append("rect")
        //   .attr("x", FboDumpD3.MARGIN_LEFT)
        //   .attr("y", 0)
        //   .attr("width", this.FULL_W)
        //   .attr("height", this.FULL_H + FboDumpD3.MARGIN_SHIFT_DOWN + FboDumpD3.MARGIN_BOTTOM);

        this.xScale = d3
            .scaleLinear()
            .domain([0, this.endCycle - this.startCycle])
            .range([0, this.FULL_W]);

        this.currentXScale = this.xScale;

        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.FULL_H);

        this.xAxisg = this.plotSvg
            .append('g')
            .attr('class', 'x axis')
            .attr('transform', `translate(${0},${this.FULL_H + FboDumpD3.MARGIN_SHIFT_DOWN})`)
            .call(this.xAxis);

        // Darker background behind the bars
        this.plotSvg
            .append('rect')
            .attr('x', 0)
            .attr('y', FboDumpD3.MARGIN_SHIFT_DOWN)
            .attr('width', this.FULL_W)
            .attr('height', this.FULL_H)
            .attr('stroke', 'white')
            .attr('stroke-width', '1px')
            .attr('fill', 'rgba(16, 22, 26, 0.3)')
            .attr('class', 'backgroundRect');

        this.opBars = this.plotSvg.append('g').attr('id', '#g_pd_opbars').attr('style', 'clip-path: url(#clipper)');

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

        for (let row = 0; row < this.totalRows; row++) {
            const boxes: Epoch[] = [];
            this.perEpochData.forEach((epochDatum) => {
                if (epochDatum.row == row) {
                    boxes.push(epochDatum);
                }
            });
            // Each row is a seperate g with an array of boxes to be plotted
            this.opBars
                .selectAll(`.g_row_${row}`)
                .data([boxes])
                .enter()
                .append('g')
                .attr('class', `g_row_${row}`)
                .attr('id', 'g_totalEpochs');
        }

        const boxRegions = d3.selectAll('#g_totalEpochs');

        boxRegions.each(function (d: Epoch[], i) {
            for (let c = 0; c < d.length; c++) {
                d3.select(this)
                    .selectAll(`.epoch-total-row-${d[c].row}-index-${c}`)
                    .data([d[c]])
                    .enter()
                    .append('rect')
                    .attr('class', `epoch-total-row-${d[c].row}-index-${c}`)
                    .attr('id', 'epoch-total')
                    .attr('fill', 'green')
                    .attr('stroke', 'white')
                    .attr('stroke-width', 1)
                    .style('cursor', 'pointer');
            }
        });

        boxRegions.each(function (d: Epoch[], i) {
            const { row } = d[0];
            d3.select(this)
                .append('line')
                .attr('class', `separator-row-${row}`)
                .attr('stroke', 'white')
                .attr('stroke-width', 1)
                .attr('opacity', 0.3);
        });
        // op name
        this.opNames = this.svg.append('g').attr('id', '#g_pd_opnames');
        // this.opNames.selectAll("g").data(this.coreOps)
        //   .enter()
        //   .append("g")
        //   .append("text")
        //   .attr("x", 0)
        //   .attr("font-size", "0.9em")
        //   .attr("stroke", "none")
        //   .attr("fill", "white")
        //   .text((op: CoreOp) => op.op_name);

        this.opNames
            .selectAll('g')
            .data(Object.keys(this.fboTable))
            .enter()
            .append('g')
            .attr('class', 'g_op_names')
            .append('text')
            .attr('font-size', () => {
                if (this.visProps.barRegionHeight > 30) {
                    return '0.9em';
                }
                if (this.visProps.barRegionHeight > 15) {
                    return '0.7em';
                }
                return '0.5em';
            })
            .attr('stroke', 'none')
            .attr('fill', 'white')
            .text((fbo: string) => fbo[0].toUpperCase() + fbo.slice(1).toLowerCase());

        this.zoomScale = 1;
        this.zoom = d3
            .zoom()
            // .x(x)
            .scaleExtent([1, Math.floor(this.endCycle / 100)])
            .on('zoom', (ev) => {
                this.zoomed(ev.transform);
            });

        this.zoom.translateExtent([
            [0, 0],
            [this.visProps.width, this.visProps.height],
        ]);
        this.plotSvg.call(this.zoom);

        this.updateBars();
        this.updateOps();
        this.updateRegionZoom();
    }

    // Delete everything
    close(): void {
        d3.select(this.d3Ref).selectAll('*').remove();
    }

    zoomed(transform: any, tDuration = 60): void {
        this.zoomScale = transform.k;
        const new_x_scale = transform.rescaleX(this.xScale);
        this.xAxisg.transition().duration(tDuration).call(this.xAxis.scale(new_x_scale));

        this.currentXScale = new_x_scale;
        this.updateBarsOnZoom(tDuration);
        this.updateRegionZoom();
    }

    // Zoom out
    resetZoom(): void {
        console.log('reset zoom');
        this.zoomed(d3.zoomIdentity, 400);
        this.plotSvg.transition().duration(0).call(this.zoom.transform, d3.zoomIdentity);
    }
}
