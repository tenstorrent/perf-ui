// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import { Op, TTGraphNode } from '../spatial_gui/compute_placement';
import { OP_COLORS } from '../common';

interface Location {
    x: number;
    y: number;
}
export interface GraphNodeElement {
    id: string;
    type: string; // Budadramqueue or default
    data: any; // { label: name }
    position: Location;
    style: any; // one of nodeStyles
    draggable: boolean;
    folderPath: string;
}

export interface GraphEdgeElement {
    id: string; // edgeId + "-" + src.id + "-" + dest.id
    source: string; // src.id
    target: string; // dest.id
    type: string; // e.g. 'bezier'
    animated: boolean;
    style: Record<string, any>; // e.g. { stroke: 'red' }
    arrowHeadType: string; // e.g. 'arrow'
}

export const get_width = (label) => {
    return 20 * label.length;
};

export const nodeStyles = {
    default: {
        border: '2px solid #FFE4B5',
        padding: 10,
        width: 100,
        background: '#D3F6F7',
        color: 'black',
        textAlign: 'center',
    },
    selected: {
        border: '4px solid #00264d',
        padding: 10,
        width: 100,
        background: '#0066cc',
        color: 'black',
        textAlign: 'center',
    },
    BudaDramQueue: {
        border: '4px solid #FFE4B5',
        padding: 10,
        width: 100,
        background: '#ACACAC',
        color: 'black',
        textAlign: 'center',
    },
};

export const getNodeStyles = (name, mode = 'default', backgroundColor = undefined) => {
    if (!(mode in nodeStyles)) {
        console.log('WARNING: The input node style does not exist. Using the default.');
        mode = 'default';
    }
    const style = nodeStyles[mode];
    let width = 100;
    if (name != null) {
        width = get_width(name);
    }
    let color = backgroundColor;
    if (color == undefined || mode == 'selected' || mode == 'BudaDramQueue') {
        color = style.background;
    }
    return {
        border: style.border,
        padding: style.padding,
        width,
        background: color,
        color: style.color,
        textAlign: style.textAlign,
    };
};

function isOpInEpoch(node: TTGraphNode | Op, selectedEpochs: Array<number>) {
    if (node != undefined && 'coreOps' in node) {
        const coreOpLen = node.coreOps.length;
        if (coreOpLen > 0) {
            if (selectedEpochs.includes(node.coreOps[0].epoch)) {
                return true;
            }
        }
        return false;
    }
    return true;
}

function getEpochId(node: GraphNode) {
    let epochId;
    if (node != undefined && 'gn' in node && 'coreOps' in node.gn) {
        const coreOpLen = node.gn.coreOps.length;
        if (coreOpLen > 0) {
            epochId = node.gn.coreOps[0].epoch;
        }
    }
    return epochId;
}

export class GraphNode {
    id: string;

    name: string;

    type: string;

    nodeColor: string | undefined;

    inputs: GraphNode[];

    outputs: GraphNode[];

    gn: TTGraphNode | Op;

    epoch: number;

    constructor(gn: TTGraphNode | Op) {
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

    setInputs(map: Map<number, GraphNode>, selectedEpochs: Array<number>): void {
        const allInputs: GraphNode[] = [];
        this.gn.inputs.forEach((node: TTGraphNode) => {
            // console.log("KD-isOpInEpoch = ", isOpInEpoch(node, selectedEpochs));
            if (isOpInEpoch(node, selectedEpochs)) {
                allInputs.push(map.get(node.uniqueId));
            }
        });
        this.inputs = allInputs;
    }

    setOutputs(map: Map<number, GraphNode>, selectedEpochs: Array<number>): void {
        const allOutputs: GraphNode[] = [];
        this.gn.outputs.forEach((node: TTGraphNode) => {
            // console.log("KD-isOpInEpoch = ", isOpInEpoch(node, selectedEpochs));
            if (isOpInEpoch(node, selectedEpochs)) {
                allOutputs.push(map.get(node.uniqueId));
            }
        });
        this.outputs = allOutputs;
        // this.outputs = this.gn.outputs.map( (gn: TTGraphNode) => map.get(gn.uniqueId)! );
    }
}
