// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import * as d3 from 'd3';
import { ZoomEvent } from 'd3-zoom';
import { graphviz, wasmFolder } from '@hpcc-js/wasm';

import { Op, TTGraphNode } from '../spatial_gui/compute_placement';
import { OP_COLORS } from '../common';

export class Graph {
    inputs: GraphNode[];

    constructor() {
        this.inputs = [];
    }

    static generate(gns: TTGraphNode[]): Graph {
        const g = new Graph();
        const map = new Map<number, GraphNode>();
        gns.forEach((gn: TTGraphNode) => {
            const n = new GraphNode(gn);
            map.set(gn.uniqueId, n);
            if (gn.type == 'Input') {
                g.inputs.push(n);
            }
        });

        map.forEach((n: GraphNode) => {
            n.setInputs(map);
            n.setOutputs(map);
        });

        return g;
    }

    populateMap(node: GraphNode, nodeMap: Map<string, GraphNode>): void {
        if (nodeMap.has(node.id)) {
            return;
        }

        nodeMap.set(node.id, node);
        node.outputs.forEach((n: GraphNode) => this.populateMap(n, nodeMap));
    }

    generateDOT(): string {
        const nodeMap = new Map<string, GraphNode>();
        this.inputs.forEach((n: GraphNode) => this.populateMap(n, nodeMap));

        let ret = `
    digraph {
      bgcolor="none"
      edge [color="#fefef6"]
      node [style="filled" color="#786bb0" shape="box"]
    `;

        // Add nodes
        nodeMap.forEach((n: GraphNode) => (ret += `${n.nodeDOT()}\n`));

        // Add connections
        nodeMap.forEach((src: GraphNode) =>
            src.outputs.forEach((dest: GraphNode) => (ret += `${src.id} -> ${dest.id}\n`)),
        );

        ret += '}\n';
        return ret;
    }
}

export class GraphNode {
    id: string;

    name: string;

    type: string;

    nodeColor: string | undefined;

    inputs: GraphNode[];

    outputs: GraphNode[];

    gn: TTGraphNode;

    constructor(gn: TTGraphNode) {
        this.gn = gn;
        this.id = gn.uniqueId.toString();
        this.name = gn.name;
        this.type = gn.type;
        this.nodeColor = undefined;

        if (this.gn instanceof Op) {
            const firstCore = this.gn.coreOps[0].computeNode.loc;
            const col = OP_COLORS[(firstCore.x + firstCore.y * 16) % OP_COLORS.length];
            const rgb = col.split(',');
            const r = `0${parseInt(rgb[0].substring(4)).toString(16)}`.slice(-2);
            const g = `0${parseInt(rgb[1]).toString(16)}`.slice(-2);
            const b = `0${parseInt(rgb[2]).toString(16)}`.slice(-2);
            const a = '88';
            this.nodeColor = `#${r}${g}${b}${a}`;
        }
    }

    shape(): string {
        if (this.type == 'Input') {
            return 'oval';
        }
        return 'box';
    }

    color(): string {
        if (this.nodeColor) {
            return this.nodeColor;
        }

        if (this.type == 'Input') {
            return '#ffd10a';
        }

        if (this.type == 'BudaDramQueue') {
            return '#786bb0';
        }

        if (this.type == 'Output') {
            return '#008cab';
        }

        if (this.type == 'Parameter') {
            return '#f04f5e';
        }

        return '#72deff';
    }

    style(): string {
        let ret = 'filled';

        if (this.type == 'Input' || this.type == 'BudaDramQueue') {
            ret += ',rounded';
        }

        return ret;
    }

    nodeDOT(): string {
        let ret = `${this.id} [id="${this.id}" label="${this.name}" type="${this.type}"`;
        ret += ` shape="${this.shape()}" color="${this.color()}" style="${this.style()}"]`;
        // console.log(ret);
        return ret;
    }

    setInputs(map: Map<number, GraphNode>): void {
        this.inputs = this.gn.inputs.map((gn: TTGraphNode) => map.get(gn.uniqueId)!);
    }

    setOutputs(map: Map<number, GraphNode>): void {
        this.outputs = this.gn.outputs.map((gn: TTGraphNode) => map.get(gn.uniqueId)!);
    }
}

interface GraphVisProps {
    width: number;
    height: number;
    gns: TTGraphNode[];
}

export const GraphVis = ({ width, height, gns }: GraphVisProps): React.ReactElement => {
    const [dot, setDot] = useState('');
    const graphRef = useRef<HTMLDivElement>(null);
    const className = 'graph-viz-div';

    useEffect(() => {
        console.log('GraphVis mounted');
        return () => {
            console.log('GraphVis unmounted');
        };
    }, []);

    useEffect(() => {
        const g = Graph.generate(gns);
        setDot(g.generateDOT());
    }, [gns]);

    useEffect(() => {
        wasmFolder('https://unpkg.com/@hpcc-js/wasm/dist/'); // TODO: change to local assets
        graphviz.layout(dot, 'svg', 'dot').then((svgData: string) => {
            if (graphRef && graphRef.current) {
                graphRef.current.innerHTML = svgData;
            } else {
                return;
            }
            const nodes = d3.selectAll('.node,.edge');
            d3.select(graphRef.current).selectAll('title').remove(); // remove tooltips for now

            const svg = d3.select(graphRef.current).selectAll('svg');

            const zoom = d3.zoom().on('zoom', (e: ZoomEvent) => {
                svg.select('#graph0').attr('transform', e.transform);
            });

            // Graph comes pre-translated to center it, so we must retrieve data value and apply it
            if (d3.select('#graph0').node()) {
                const { matrix } = d3.select('#graph0').node().transform.baseVal.consolidate();
                zoom.translateBy(svg, matrix.e, matrix.f);
            }
            // zoom.scaleExtent([0.8, 4]);
            //
            d3.select(graphRef.current).selectAll('svg').attr('height', height).attr('width', width).call(zoom);

            nodes
                .call(function (this: any) {
                    /* console.log(d3.select(this)); */
                })
                .on('click', function (this: any, event, d) {
                    console.log(d3.select(this).node());
                    console.log(d3.select(this).node().id);
                    // console.log(d3.select(this).node().attributes);
                });
        });

        /* graphviz("." + className)
      .attributer( function(d) {
        //console.log("Item:", d)
        if (d.tag == "ellipse") {
          (d3.select(this)
                .attr("fill", "yellow");
          //d.attributes.fill = "red";
        }
      });
    console.log("data:", graphviz("." + className).data()); */
    }, [dot]);

    // return <Graphviz className={className} dot={graph.generateDOT()} options={{width: visProps.width, height: visProps.height, zoom: true}} />;
    return <div className={className} ref={graphRef} style={{ maxHeight: height, height, width }} />;
};
