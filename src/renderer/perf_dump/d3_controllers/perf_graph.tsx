// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import React, { ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import ReactFlow, { Controls, MiniMap, ReactFlowProvider, isNode } from 'react-flow-renderer';
// you need these styles for React Flow to work properly
import 'react-flow-renderer/dist/style.css';

// additionally you can load the default theme
import 'react-flow-renderer/dist/theme-default.css';

import dagre from 'dagre';
import { Label } from '@blueprintjs/core';
import { GraphEdgeElement, GraphNodeElement, getNodeStyles, get_width, nodeStyles } from '../graph_utils';
import { HostEvent, Op, PerfDumpVisProps, getEpochId, getGraphId, processData } from '../perf_utils';
import { GraphModelRuntimeThreshold } from '../components';
import PerfDumpD3Controller from './perf_dump_d3';

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

export default class GraphD3Controller extends React.Component<any, any> {
    graphRef: HTMLDivElement;

    visProps: PerfDumpVisProps;

    computegrid;

    svg: any; // main SVG reference

    plotSvg: any; // SVG that contains bars and x axis, child of main SVG reference

    FULL_W: number; // width and height of the area in which bars/lines are drawn

    FULL_H: number;

    BAR_REGION_HEIGHT: number; // height of space for one op

    // original and current X scale
    xScale: CallableFunction;

    currentXScale: CallableFunction;

    xAxis: any;

    setGraphPlot: (graphPlot: React.ReactElement) => void;

    siliconData: Map<string, Record<string, any>>;

    modelData: Map<string, Record<string, any>> | null;

    graphData: Map<string, string>;

    hostData: Map<string, Record<string, any>> | null;

    allInputs: string[];

    allFolderPaths: string[];

    folderPaths: string[]; // selected folderpaths to be plotted

    opMap: Record<string, Op>;

    hostEventMap: Record<string, HostEvent[]>;

    inputs: string[];

    consoleHeight: number;

    selectedSiliconData: Map<string, any> = new Map();

    selectedModelData: Map<string, any> = new Map();

    resetPerfViewZoom = false;

    perfDumpD3Component: PerfDumpD3Controller | null;

    // Draw parameters
    static MARGIN_TOP = 1; // margin at the top of the whole chart

    static MARGIN_BOTTOM = 10; // margin at the bottom of the whole chart

    static MARGIN_LEFT = 1; // margin on the left, for op names and other info

    static MARGIN_SHIFT_DOWN = 20;

    constructor(
        graphRef: HTMLDivElement,
        visProps: PerfDumpVisProps,
        setGraphPlot: (plot: ReactElement) => void,
        siliconData: Map<string, Record<string, any>>,
        modelData: Map<string, Record<string, any>> | null,
        graphData: Map<string, string>,
        hostData: Map<string, Record<string, any>> | null,
    ) {
        super({});
        this.graphRef = graphRef;
        this.visProps = visProps;
        this.state = {};
        this.setGraphPlot = setGraphPlot;
        this.siliconData = siliconData;
        this.modelData = modelData;
        this.graphData = graphData;
        this.hostData = hostData;
        this.consoleHeight = 0;
        this.setFolderPaths();
        this.folderPaths.forEach((folderPath: string) => {
            this.selectedSiliconData.set(folderPath, {
                'per-epoch-events': siliconData.get(folderPath)['per-epoch-events'],
            });
            this.selectedModelData.set(folderPath, {});
            console.log('KD-here-selectedSiliconData = ', this.selectedSiliconData);
            console.log('KD-here-selectedModelData = ', this.selectedModelData);
        });
        this.allInputs = this.visProps.allInputs;
        this.allInputs.sort((a, b) => parseInt(a.split('-').pop()) - parseInt(b.split('-').pop()));
        this.setInputs();
        [this.opMap] = processData(
            this.siliconData,
            this.modelData,
            null,
            this.folderPaths,
            this.allInputs,
            this.visProps,
        );
        this.calculateDrawingParameters();
        this.draw();
    }

    resetZoom(): void {
        this.resetPerfViewZoom = true;
    }

    setFolderPaths(): void {
        this.folderPaths = this.visProps.selectedFolderPaths
            .map((folderPath: string[]) => folderPath.join('/'))
            .filter((folderPath: string) => getGraphId(folderPath) != '' || getEpochId(folderPath) != '');
    }

    // on epochs, cores, fields changes.
    update(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        this.setFolderPaths();
        if (this.folderPaths.length == 0 || this.inputs.length == 0) {
            this.close();
            return;
        }
        this.inputs = this.visProps.selectedInputs;
        this.calculateDrawingParameters();
        this.draw();
    }

    // on height, width, bar region height changes.
    resizeSVG(newVisProps: PerfDumpVisProps): void {
        this.visProps = newVisProps;
        this.calculateDrawingParameters();
        this.draw();
    }

    setInputs(): void {
        if (this.visProps.selectedInputs.includes('Show All Inputs')) {
            this.inputs = this.visProps.allInputs;
        } else {
            this.inputs = [...this.visProps.selectedInputs];
        }
        this.inputs.sort((a, b) => parseInt(a.split('-').pop()) - parseInt(b.split('-').pop()));
    }

    calculateEarliestStartToLatestEnd(expandedOpName: string): number {
        // siliconRuntime = this.opMap[expandedOpName].bounds.medHigh - this.opMap[expandedOpName].bounds.medLow;
        let siliconRuntime = 0;
        if (this.opMap[expandedOpName].coreOps.length > 0) {
            let earliestStart = 0;
            let latestEnd = 0;
            this.opMap[expandedOpName].coreOps.forEach((core) => {
                if (earliestStart > core.unpackerFirstBlockDataAvailable || earliestStart == 0) {
                    earliestStart = core.unpackerFirstBlockDataAvailable;
                }
                if (latestEnd < core.packFinishLastOuterLoop) {
                    latestEnd = core.packFinishLastOuterLoop;
                }
            });

            // siliconRuntime = this.opMap[expandedOpName].coreOps[0].packFinishLastOuterLoop - this.opMap[expandedOpName].coreOps[0].unpackerFirstBlockDataAvailable;
            siliconRuntime = latestEnd - earliestStart;
        }
        return siliconRuntime;
    }

    parseGraphData(): Array<GraphNodeElement | GraphEdgeElement> {
        const nodeRegex = /^(\d+)\[label="(\S+)"\] \[is_queue="(\d+)"\];$/;
        const edgeRegex = /^(\d+)->(\d+) \[label="(\S+)"\];$/;
        const nodesToPlot: Record<string, string[]> = {};
        const edgesToPlot: Record<string, string[]> = {};
        const queuesToPlot: string[] = [];
        // node map folderpath-id contains the info of the node that has id under folderpath.
        const nodeMap: Record<string, any> = {};

        for (const folderPath of this.folderPaths) {
            nodesToPlot[folderPath] = [];
            if (!this.graphData.has(folderPath)) {
                console.log(`No graph data for path: ${folderPath}`);
                continue;
            }
            const content = this.graphData.get(folderPath).split('\n');
            const nodes: string[] = content.filter((line: string) => nodeRegex.test(line)); // contains digraph text that describe vertices
            const edges: string[] = content.filter((line: string) => edgeRegex.test(line)); // contains digraph text that describe edges
            for (const node of nodes) {
                const id = node.match(nodeRegex)[1];
                const label = node.match(nodeRegex)[2];
                const isQueue = node.match(nodeRegex)[3];
                nodeMap[`${folderPath}-${id}`] = {
                    isQueue,
                    label,
                };
                // if the node is a queue we never seen before, push it to nodes to plot and queues to plot
                if (isQueue == '1' && !queuesToPlot.includes(label)) {
                    queuesToPlot.push(label);
                    nodesToPlot[folderPath].push(node);
                }
                // if the node is not a queue, push it to nodes to plot
                else if (isQueue == '0') {
                    nodesToPlot[folderPath].push(node);
                }
            }
            edgesToPlot[folderPath] = edges;
        }

        let graphNodes: GraphNodeElement[] = [];
        for (const [folderPath, nodes] of Object.entries(nodesToPlot)) {
            const nodeElements = nodes.map((info: string) => {
                const type = info.match(nodeRegex)[3] == '1' ? 'BudaDramQueue' : 'default';
                let id = '';
                // if the node is a queue, it is shared across programs, thus we don't need to make its id unique,
                // every q0 in each program refers to the same queue.
                if (type == 'BudaDramQueue') {
                    id = info.match(nodeRegex)[2];
                }
                // if the node is not a queue, then we need to make its id unique, as we could have multiple binary0 ops
                // in different programs that are non-correlated.
                else if (type == 'default') {
                    id = `${folderPath} op-${info.match(nodeRegex)[2]} id-${info.match(nodeRegex)[1]}`;
                }

                return {
                    id,
                    type,
                    data: {
                        label: info.match(nodeRegex)[2],
                        graph: folderPath.split('/').pop(),
                    }, // {label: op-name}, used to extract data from perf dump data.
                    position: { x: 10, y: 20 }, // placeholder position, to be modified by dagre
                    style: nodeStyles[type], // one of nodeStyles
                    draggable: true,
                    folderPath,
                };
            });
            graphNodes = graphNodes.concat(nodeElements);
        }

        let edgeId = 0;
        let graphEdges: GraphEdgeElement[] = [];
        const getEdgeSourceDest = (edgeInfo: string, folderPath: string): [string, string] => {
            const srcId = edgeInfo.match(edgeRegex)[1];
            const destId = edgeInfo.match(edgeRegex)[2];
            const srcNode = nodeMap[`${folderPath}-${srcId}`];
            console.assert(srcNode != undefined, 'Source node for edge should be in node map');
            const destNode = nodeMap[`${folderPath}-${destId}`];
            console.assert(destNode != undefined, 'Dest node for edge should be in node map');
            let source = '';
            if (srcNode.isQueue == '1') {
                source = srcNode.label;
            } else if (srcNode.isQueue == '0') {
                source = `${folderPath} op-${srcNode.label} id-${srcId}`;
            }

            let dest = '';
            if (destNode.isQueue == '1') {
                dest = destNode.label;
            } else if (destNode.isQueue == '0') {
                dest = `${folderPath} op-${destNode.label} id-${destId}`;
            }

            return [source, dest];
        };

        for (const [folderPath, edges] of Object.entries(edgesToPlot)) {
            const edgeElements: GraphEdgeElement[] = edges.map((info: string) => {
                const [source, dest] = getEdgeSourceDest(info, folderPath);
                const id = `${edgeId}-${source}-${dest}`;
                edgeId++;
                return {
                    id,
                    source,
                    target: dest,
                    type: 'bezier',
                    animated: false,
                    style: { stroke: 'red' },
                    arrowHeadType: 'arrow',
                };
            });
            graphEdges = graphEdges.concat(edgeElements);
        }
        console.log('Nodes and edges: ', [...graphNodes, ...graphEdges]);
        return [...graphNodes, ...graphEdges];
    }

    GraphGenWrapper = ({ width, height }): React.ReactElement => {
        const [dot, setDot] = useState<Array<any>>([]);
        const [selectedNodesIds, setselectedNodesIds] = useState<Array<any>>([]);
        const [selectedNodes, setselectedNodes] = useState<Array<any>>([]);
        const [graphRuntimeTh, setGraphRuntimeTh] = useState(20);
        const [consolePerfView, setConsolePerfView] = useState('bars');
        const [displayBars, setDisplayBars] = useState(false);
        const nodeHeight = 36;
        const d3ref = useRef(null);

        const layoutElements = (elements: any, direction = 'TB') => {
            dagreGraph.setGraph({ rankdir: direction, align: 'UL' });
            elements.forEach((el) => {
                if (isNode(el)) {
                    dagreGraph.setNode(el.id, {
                        width: get_width(el.data.label),
                        height: nodeHeight,
                    });
                } else {
                    dagreGraph.setEdge(el.source, el.target);
                }
            });
            dagre.layout(dagreGraph);
            const isHorizontal = direction === 'LR';
            return elements.map((el) => {
                if (isNode(el)) {
                    let style;
                    let modelRuntime = 0;
                    let siliconRuntime = 0;
                    let backgroundColor;
                    if (el.folderPath != undefined) {
                        console.assert(
                            this.inputs.length == 1 || this.inputs.length == 0,
                            'The number of elements in the list of inputs in graph-mode must be 0 or 1.',
                        );
                        let expandedOpName;
                        if (this.inputs.length > 1) {
                            expandedOpName = Op.getFullName(
                                el.data.label,
                                el.folderPath,
                                parseInt(this.inputs[0].split('-').pop()),
                            );
                        }
                        if (expandedOpName in this.opMap) {
                            modelRuntime = this.opMap[expandedOpName].modelCyclesProp;
                            // this.opMap[expandedOpName].calculateBounds(0);
                            siliconRuntime = this.calculateEarliestStartToLatestEnd(expandedOpName);
                            if (siliconRuntime != 0 && modelRuntime != 0) {
                                if (siliconRuntime < modelRuntime * (1 + graphRuntimeTh / 100)) {
                                    backgroundColor = '#99ff66';
                                } else {
                                    backgroundColor = '#ff3300';
                                }
                            }
                        }
                    }
                    if (selectedNodesIds.includes(el.id)) {
                        style = getNodeStyles(el.data.label, 'selected', backgroundColor);
                    } else {
                        style = getNodeStyles(el.data.label, el.type, backgroundColor);
                    }
                    el.style = style;
                    const nodeWithPosition = dagreGraph.node(el.id);
                    el.targetPosition = isHorizontal ? 'left' : 'top';
                    el.sourcePosition = isHorizontal ? 'right' : 'bottom';

                    // unfortunately we need this little hack to pass a slightly different position
                    // to notify react flow about the change. Moreover we are shifting the dagre node position
                    // (anchor=center center) to the top left so it matches the react flow node anchor point (top left).
                    el.position = {
                        x: nodeWithPosition.x - (2 * get_width(el.data.label)) / 2 + Math.random() / 1000,
                        y: nodeWithPosition.y - (2 * nodeHeight) / 2,
                    };
                }

                return el;
            });
        };

        // const graphNodes = useMemo(() => workload.modules[0].getGraphNodes(), [workload]);
        // const graphNodes = useMemo( () => workload.modules[0].getGraphOps(), [workload]);

        useEffect(() => {
            const elements = this.parseGraphData();
            setDot(layoutElements(elements));
        }, [
            selectedNodesIds,
            this.folderPaths,
            graphRuntimeTh,
            this.visProps.selectedInputs,
            this.visProps.showModelNumbers,
        ]);

        const onLoad = (reactFlowInstance) => {
            reactFlowInstance.fitView();
        };

        // const onFitView = () => {

        // }

        const onElementClick = (event, el, prevNodes = []) => {
            // console.log("UPDATING SELECTED NODES IN GRAPH DUMP:")
            if (el != null && isNode(el) && el.type != 'BudaDramQueue') {
                // console.log("SETTING SELECTED NODES ON CLICK IN GRAPH DUMP:")
                if (!selectedNodesIds.includes(el.id)) {
                    setselectedNodesIds(selectedNodesIds.concat([el.id]));
                    setselectedNodes(selectedNodes.concat([el]));
                } else {
                    setselectedNodesIds(selectedNodesIds.filter((i, _) => i !== el.id));
                    setselectedNodes(selectedNodes.filter((i, _) => i.id !== el.id));
                }
            }
        };
        const onSelectionChange = (el) => {
            onElementClick('click', el);
        };

        const onPaneClick = (el) => {
            // console.log("CLICKED PANE IN GRAPH DUMP:")
            setselectedNodesIds([]);
            setselectedNodes([]);
        };

        const onNodeDoubleClick = (event, el) => {
            console.log('double clicked on node el:', el);
        };

        useEffect(() => {
            this.consoleHeight = selectedNodesIds.length == 0 ? 0 : height / 3;
            setDisplayBars(selectedNodesIds.length > 0);
            // if (d3Controller && selectedNodes.length == 0) {
            //     d3Controller.close();
            //     if (d3ref != null && d3ref.current != null) {
            //         d3ref.current.remove();
            //     }
            // }
        }, [selectedNodesIds]);

        useEffect(() => {
            console.log('selected nodes: ', selectedNodes);
            for (const folderPath of this.selectedSiliconData.keys()) {
                this.selectedSiliconData.set(folderPath, {
                    'per-epoch-events': this.siliconData.get(folderPath)['per-epoch-events'],
                });
            }
            if (this.siliconData != null) {
                for (const node of selectedNodes) {
                    const folderPath = node.id.split(' ')[0];
                    if (!this.folderPaths.includes(folderPath)) {
                        continue;
                    }
                    // console.log("NODE: ", node);
                    // console.log("NODE FOLDET PATH: ", folderPath);
                    const data = this.siliconData.get(folderPath);
                    for (const [opName, opData] of Object.entries(data)) {
                        const opRegex = `^(\\d+)-(\\d+)-${node.data.label}$`;
                        if (RegExp(opRegex).test(opName)) {
                            this.selectedSiliconData.get(folderPath)[opName] = opData;
                        }
                    }
                }
            }
            console.log('Selcted silicon data in graph dump: ', this.selectedSiliconData);
            for (const folderPath of this.selectedModelData.keys()) {
                this.selectedModelData.set(folderPath, {});
            }
            if (this.modelData != null) {
                for (const node of selectedNodes) {
                    const folderPath = node.id.split(' ')[0];
                    if (!this.folderPaths.includes(folderPath)) {
                        continue;
                    }
                    const data = this.modelData.get(folderPath);
                    for (const [opName, opData] of Object.entries(data)) {
                        const opRegex = `^(\\d+)-(\\d+)-${node.data.label}$`;
                        if (RegExp(opRegex).test(opName)) {
                            this.selectedModelData.get(folderPath)[opName] = opData;
                        }
                    }
                }
            }

            this.perfDumpD3Component && this.perfDumpD3Component.close();
            this.perfDumpD3Component = null;
            this.perfDumpD3Component = new PerfDumpD3Controller(
                d3ref.current,
                this.visProps,
                this.selectedSiliconData,
                this.selectedModelData,
                this.hostData,
                selectedNodes.length > 0,
                false,
            );
        }, [selectedNodes]);

        const handleNodeMouseOver = (e: React.MouseEvent, node) => {
            const text = [];
            text.push(
                '<tr>',
                `<td id="name">` + `<span style="color: black; font-size: 18px;">${node.data.label}</span>` + `</td>`,
                '<br>',
                `<td id="graph">` +
                    `<span style="color: black;">` +
                    `Graph: ` +
                    `</span>` +
                    `<span style="color: blue;">${node.data.graph}</span>` +
                    `</td>`,
                '<br>',
                `<td id="node-type">` +
                    `<span style="color: black;">` +
                    `Node type: ` +
                    `</span>` +
                    `<span style="color: blue;">${node.type == 'BudaDramQueue' ? 'BudaDramQueue' : 'Op'}</span>` +
                    `</td>`,
                '</tr>',
            );
            d3.select(this.graphRef)
                .append('div')
                .attr('id', 'graph-tooltip')
                .style('position', 'absolute')
                .style('background-color', 'white')
                .style('border', 'solid')
                .style('border-width', '2px')
                .style('border-radius', '5px')
                .style('padding', '5px')
                .html(text.join(''))
                .style('opacity', 0.9)
                .style('left', `${e.pageX + 10}px`)
                .style('top', `${e.pageY + 10}px`);
        };

        const handleNodeMouseOut = () => {
            d3.select(this.graphRef).selectAll('#graph-tooltip').remove();
        };

        return (
            <div
                className="pd-react-flow-graph"
                key="pd-react-flow-graph-container"
                style={{
                    position: 'relative',
                    left: `${GraphD3Controller.MARGIN_LEFT}px`,
                    top: `${GraphD3Controller.MARGIN_TOP}px`,
                    height: height - this.consoleHeight - 40,
                    width,
                }}
            >
                <div>
                    <Label
                        style={{
                            position: 'relative',
                            left: `${GraphD3Controller.MARGIN_LEFT}px`,
                            top: `${GraphD3Controller.MARGIN_TOP}px`,
                            color: 'white',
                            width: 500,
                            height: 10,
                        }}
                    >
                        Runtime v Model threshold %{' '}
                    </Label>
                    <GraphModelRuntimeThreshold graphRuntimeTh={graphRuntimeTh} setGraphRuntimeTh={setGraphRuntimeTh} />
                </div>
                <ReactFlowProvider>
                    <ReactFlow
                        elements={dot}
                        onLoad={onLoad}
                        onElementClick={onElementClick}
                        onSelectionChange={onSelectionChange}
                        onNodeDoubleClick={onNodeDoubleClick}
                        onPaneClick={onPaneClick}
                        onNodeMouseEnter={handleNodeMouseOver}
                        onNodeMouseLeave={handleNodeMouseOut}
                    >
                        <MiniMap
                            style={{
                                background: 'black',
                                borderColor: 'blue',
                            }}
                            nodeStrokeColor={(n) => {
                                if (n.style?.background) {
                                    return n.style.background;
                                }
                            }}
                            nodeColor={(n) => {
                                if (n.style?.background) {
                                    return n.style.background;
                                }
                            }}
                            nodeBorderRadius={2}
                        />
                        <Controls />
                    </ReactFlow>
                    {/* <Background
                    variant="dots"
                    gap={12}
                    size={4}
                    /> */}
                </ReactFlowProvider>
                <div className="graph-tabs" style={{ height: 30, width }}>
                    <button
                        className="graph-perf-view-tab"
                        onClick={() => setConsolePerfView('bars')}
                        style={{ display: selectedNodes.length == 0 ? 'none' : 'inline' }}
                    >
                        Perf View
                    </button>
                    <button
                        className="graph-perf-info-tab"
                        onClick={() => setConsolePerfView('info')}
                        style={{ display: selectedNodes.length == 0 ? 'none' : 'inline' }}
                    >
                        Info
                    </button>
                </div>
                <div
                    ref={d3ref}
                    className="graph-perf-view-content"
                    style={{
                        position: 'relative',
                        left: `${GraphD3Controller.MARGIN_LEFT}px`,
                        top: `${GraphD3Controller.MARGIN_TOP}px`,
                        height: this.consoleHeight - 30,
                        width,
                        display: consolePerfView == 'bars' && selectedNodes.length > 0 ? 'block' : 'none',
                    }}
                />
                <div
                    className="graph-perf-info-content"
                    style={{
                        position: 'relative',
                        left: `${GraphD3Controller.MARGIN_LEFT}px`,
                        top: `${GraphD3Controller.MARGIN_TOP}px`,
                        height: this.consoleHeight - 30,
                        width,
                        display: consolePerfView == 'info' && selectedNodes.length > 0 ? 'block' : 'none',
                    }}
                >
                    {' '}
                    This is the info section{' '}
                </div>
            </div>
        );
    };

    // Delete everything
    close(): void {
        console.log('Closing graph dump d3');
        this.perfDumpD3Component && this.perfDumpD3Component.close();
        this.perfDumpD3Component = null;
        this.siliconData = null;
        this.modelData = null;
        this.graphData = null;
        this.selectedSiliconData = null;
        this.selectedModelData = null;
        this.opMap = {};
        d3.select(this.graphRef).selectAll('*').remove();
        d3.select(this.graphRef).style('display', 'none');
        d3.selectAll('.pd-react-flow-graph').selectAll('*').remove();
        // this.draw();
    }

    calculateDrawingParameters(): void {
        // TODO: Scale margin top as bars become crowded
        // Calculate drawing parameters
        GraphD3Controller.MARGIN_TOP = this.visProps.barRegionHeight / 80;
        this.FULL_W = this.visProps.width - GraphD3Controller.MARGIN_LEFT;
        this.BAR_REGION_HEIGHT = this.visProps.barRegionHeight;
        const panelHeight =
            this.visProps.height -
            GraphD3Controller.MARGIN_TOP -
            GraphD3Controller.MARGIN_BOTTOM -
            GraphD3Controller.MARGIN_SHIFT_DOWN;
        this.FULL_H = panelHeight;
        // this.FULL_H = Math.max(panelHeight, this.BAR_REGION_HEIGHT * Object.keys(this.coreOps).length);
        // console.log("NUMBER OF OPS")
        // console.log(this.coreOps.length)
    }

    draw(): void {
        d3.select(this.graphRef).selectAll('.perf-graph-dump-d3').remove();
        d3.select(this.graphRef).selectAll('.graph-dump-d3-plot').remove();
        d3.select(this.graphRef).selectAll('.backgroundRect').remove();
        // d3.select(this.graphRef).append('div').html(
        //     <GraphGenWrapper width={this.visProps.width} height={this.FULL_H} workload={this.workload}/>
        // );
        // this.setState({setGraphPlot: <GraphGenWrapper width={this.visProps.width} height={this.FULL_H} workload={this.workload}/>});
        // this.all_data = <GraphGenWrapper width={this.visProps.width} height={this.FULL_H} workload={this.workload}/>;
        // this.state.setGraphPlot = <GraphGenWrapper width={this.visProps.width} height={this.FULL_H} workload={this.workload}/>;
        this.setGraphPlot(<this.GraphGenWrapper width={this.visProps.width} height={this.FULL_H} />);
        d3.select(this.graphRef)
            .style('display', 'inline-block')
            .style('max-height', `${this.visProps.height + GraphD3Controller.MARGIN_SHIFT_DOWN}px`)
            .style('overflow', 'auto')
            .style('border', 'solid')
            .style('border-width', '2px')
            .style('border-radius', '5px');
        //   .style("background", "rgb(18, 12, 6)")

        this.svg = d3
            .select(this.graphRef)
            .append('svg')
            .attr('width', this.visProps.width)
            .attr('height', this.FULL_H + GraphD3Controller.MARGIN_SHIFT_DOWN + GraphD3Controller.MARGIN_BOTTOM)
            .attr('class', 'perf-graph-dump-d3')
            .attr('viewBox', [
                0,
                0,
                this.visProps.width,
                this.FULL_H + GraphD3Controller.MARGIN_SHIFT_DOWN + GraphD3Controller.MARGIN_BOTTOM,
            ]);

        this.plotSvg = this.svg
            .append('svg')
            .attr('x', 0, 'y', GraphD3Controller.MARGIN_TOP)
            .attr('width', this.visProps.width)
            .attr('height', this.visProps.height)
            .attr('class', 'graph-dump-d3-plot');

        this.plotSvg
            .append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', this.visProps.width)
            .attr('height', this.visProps.height)
            .attr('stroke', 'white')
            .attr('stroke-width', '1px')
            .attr('fill', 'rgb(18, 12, 6)')
            .attr('class', 'backgroundRect');
    }

    getNumPlottedElements(): number {
        return Object.keys(this.opMap).length;
    }
}
