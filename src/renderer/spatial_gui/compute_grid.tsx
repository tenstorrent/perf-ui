// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

/**
 * Classes that represent a full compute grid. This is a static description of hardware
 */

// Disabling errors on "Object". We're ok with using it, since we'll validate it with superstruct.
/* eslint-disable @typescript-eslint/ban-types */

import { validateComputeGrid } from './json_validate';

export class ComputeNodeLoc {
    compute_node: DeviceCr;

    device: SystemCr;

    system: SystemCr;

    constructor(compute_node: DeviceCr, device: SystemCr, system: SystemCr) {
        this.compute_node = compute_node;
        this.device = device;
        this.system = system;
    }

    static fromJSON(c: Object): ComputeNodeLoc {
        return new ComputeNodeLoc(
            { x: c.compute_node.x, y: c.compute_node.y },
            { x: c.device.x, y: c.device.y },
            { x: c.system.x, y: c.system.y },
        );
    }

    key(): string {
        return `${this.system.x},${this.system.y},${this.device.x},${this.device.y},${this.compute_node.x},${this.compute_node.y}`;
    }
}

/** Represents all computing resources available */
export class ComputeGrid {
    /** List of systems in the compute grid */
    systems: System[];

    /** Map of computenodes in full compute grid */
    nodeMap: Map<string, ComputeNode>;

    nodeMapLoc: Map<string, ComputeNode>;

    /** Map of links */
    linkMap: Map<string, NOCLink>;

    static fromJSON(o: Object): ComputeGrid {
        // Validate
        validateComputeGrid(o);

        const r = new ComputeGrid();
        r.systems = (o.systems as Object[]).map((c: Object): System => System.fromJSON(c));
        console.log('r is: ', r);

        r.combineMaps();
        return r;
    }

    combineMaps(): void {
        // Combine node maps into one
        this.nodeMap = this.systems.reduce((combined, list) => {
            return new Map([...combined, ...list.nodeMap]);
        }, new Map());
        this.nodeMapLoc = this.systems.reduce((combined, list) => {
            return new Map([...combined, ...list.nodeMapLoc]);
        }, new Map());

        this.linkMap = this.systems.reduce((combined, list) => {
            return new Map([...combined, ...list.linkMap]);
        }, new Map());
    }

    // Generate a quick standard grid of cores, no connections
    static standardGrid({ x, y }: { x: number; y: number }): ComputeGrid {
        const cg = new ComputeGrid();
        const sys = new System();
        sys.uniqueId = 0;
        sys.name = 'system0';
        sys.type = 'standardSystem';
        sys.shape = { x: 1, y: 1 };

        const computeNodes: ComputeNode[] = [];

        let cnId = 0;
        for (let xi = 0; xi < x; xi++) {
            for (let yi = 0; yi < y; yi++) {
                const cn = new ComputeNode();
                cn.uniqueId = `tensix_${cnId++}`;
                cn.type = ComputeNodeType.TENSIX;
                cn.computeNodeLoc = new ComputeNodeLoc({ x: xi, y: yi }, { x: 0, y: 0 }, { x: 0, y: 0 });
                cn.loc = { x: xi, y: yi };
                cn.memorySize = 1;
                computeNodes.push(cn);
            }
        }

        const nodeMap = new Map(computeNodes.map((node: ComputeNode): [string, ComputeNode] => [node.uniqueId, node]));
        const nodeMapLoc = new Map(
            computeNodes.map((node: ComputeNode): [string, ComputeNode] => [node.computeNodeLoc.key(), node]),
        );

        const device = new Device(
            sys,
            0,
            'device0',
            'standardDevice',
            { x: 0, y: 0 },
            { x, y },
            computeNodes,
            nodeMap,
            nodeMapLoc,
            1,
            [],
            [],
            [],
            [],
        );

        computeNodes.forEach((cn: ComputeNode) => {
            cn.device = device;
        });

        sys.devices = [device];
        cg.systems = [sys];

        sys.combineMaps();
        cg.combineMaps();

        return cg;
    }
}

/** Represents a single server node that has one or more devices and CPUs */
export class System {
    uniqueId: number;

    /** Free-form name and type used to identify what kind of a system this is */
    name: string;

    type: string;

    /** Shape of the system (grid of devices */
    shape: SystemCr;

    /** List of devices */
    devices: Device[];

    /** Map of computenodes in system */
    nodeMap: Map<string, ComputeNode>;

    nodeMapLoc: Map<string, ComputeNode>;

    /** Map of links */
    linkMap: Map<string, NOCLink>;

    static fromJSON(o: Object): System {
        const r = Object.assign(new System(), o);
        r.uniqueId = o.uniqueId;

        r.devices = (o.devices as Object[]).map((c: Object): Device => Device.fromJSON(c, r));

        r.combineMaps();
        return r;
    }

    combineMaps(): void {
        // Combine node maps into one
        this.nodeMap = this.devices.reduce((combined, list) => {
            return new Map([...combined, ...list.nodeMap]);
        }, new Map());
        this.nodeMapLoc = this.devices.reduce((combined, list) => {
            return new Map([...combined, ...list.nodeMapLoc]);
        }, new Map());

        this.linkMap = this.devices.reduce((combined, list) => {
            return new Map([...combined, ...list.linkMap]);
        }, new Map());
    }
}

/** Represent one device - a grayskull, wormhole, etc. or a CPU */
export class Device {
    uniqueId: number;

    system: System;

    /** Free-form name and type used to identify what kind of a device this is */
    name: string;

    type: string;

    /** Location in system */
    loc: SystemCr;

    /** Shape of the ship in compute nodes. This is always 2D */
    shape: DeviceCr;

    /** Compute nodes arranged in a grid based on their location */
    computeNodesGrid: ComputeNode[][];

    /** Flat list of compute nodes */
    computeNodes: ComputeNode[];

    /** compute nodes map of unique_id -> compute node */
    nodeMap: Map<string, ComputeNode>;

    nodeMapLoc: Map<string, ComputeNode>;

    /** NOC links, arranged based on NOC id, and then source grid location */
    nocLinksGrid: NOCLink[][][];

    /** Flag list of NOC links */
    nocLinks: NOCLink[];

    /** Map of links based on string n<NOCID>x<X>y<Y><direction> */
    linkMap: Map<string, NOCLink>;

    /** Other links */
    dramLinks: DRAMLink[];

    ethernetLinks: EthernetLink[];

    pcieLinks: PCIELink[];

    /** Number of NOCs on device */
    nocCount: number;

    constructor(
        system: System,
        uniqueId: number,
        name: string,
        type: string,
        loc: SystemCr,
        shape: DeviceCr,
        computeNodes: ComputeNode[],
        nodeMap: Map<string, ComputeNode>,
        nodeMapLoc: Map<string, ComputeNode>,
        nocCount: number,
        nocLinks: NOCLink[],
        dramLinks: DRAMLink[],
        ethernetLinks: EthernetLink[],
        pcieLinks: PCIELink[],
    ) {
        this.system = system;
        this.uniqueId = uniqueId;
        this.name = name;
        this.type = type;
        this.loc = loc;
        this.shape = shape;
        this.computeNodes = computeNodes;
        this.nodeMap = nodeMap;
        this.nodeMapLoc = nodeMapLoc;
        this.computeNodesGrid = new Array(this.shape.x);
        for (let i = 0; i < this.shape.x; i++) {
            this.computeNodesGrid[i] = new Array(this.shape.y);
        }

        // Place into the grid
        if (computeNodes.length != this.shape.x * this.shape.y) {
            throw Error(
                `Invalid length (${
                    computeNodes.length
                } for the list of ComputeNodes. Must be equal to the total grid size (${this.shape.x * this.shape.y}).`,
            );
        }

        computeNodes.forEach((node) => {
            node.device = this;
            if (node.loc.x < 0 || node.loc.x >= this.shape.x) {
                throw Error(`Invalid location X for ComputeNode ${node}`);
            }
            if (node.loc.y < 0 || node.loc.x >= this.shape.x) {
                throw Error(`Invalid location Y for ComputeNode ${node}`);
            }
            this.computeNodesGrid[node.loc.x][node.loc.y] = node;
        });

        // Place NOC links onto their grid
        // if (nocLinks.length != this.shape.x * this.shape.y * nocCount)
        //  throw Error("Invalid length for the list of NOC Links. Must be equal to the total grid size.");

        this.nocCount = nocCount;
        this.nocLinks = nocLinks;
        this.nocLinksGrid = new Array(nocCount);
        for (let nocId = 0; nocId < nocCount; nocId++) {
            this.nocLinksGrid[nocId] = new Array(this.shape.x);
            for (let i = 0; i < this.shape.x; i++) {
                this.nocLinksGrid[nocId][i] = new Array(this.shape.y);
            }
        }

        nocLinks.forEach((link) => {
            if (link.loc().x < 0 || link.loc().x >= this.shape.x) {
                throw Error(
                    `Invalid location for NOC link ${link.loc().x}:${link.loc().y} in ${this.shape.x}:${this.shape.y}`,
                );
            }
            if (link.loc().y < 0 || link.loc().y >= this.shape.y) {
                throw Error(
                    `Invalid location for NOC link: ${link.loc().x}:${link.loc().y} in ${this.shape.x}:${this.shape.y}`,
                );
            }
            if (link.nocId < 0 || link.nocId >= nocCount) {
                throw Error(`Invalid NOC Id for link ${link}`);
            }
            this.nocLinksGrid[link.nocId][link.loc().x][link.loc().y] = link;
        });

        this.linkMap = new Map(nocLinks.map((link: NOCLink): [string, NOCLink] => [link.uniqueId, link]));

        this.dramLinks = dramLinks;
        this.ethernetLinks = ethernetLinks;
        this.pcieLinks = pcieLinks;
    }

    static fromJSON(o: Object, system: System): Device {
        const deviceUniqueId = o.uniqueId;
        const computeNodes = (o.computeNodes as Object[]).map(
            (c: Object): ComputeNode => ComputeNode.fromJSON(c, deviceUniqueId, system.uniqueId),
        );

        // Create a map of ComputeNodes to match IDs to newly created objects
        const nodeMap = new Map(computeNodes.map((node: ComputeNode): [string, ComputeNode] => [node.uniqueId, node]));
        const nodeMapLoc = new Map(
            computeNodes.map((node: ComputeNode): [string, ComputeNode] => [node.computeNodeLoc.key(), node]),
        );
        const nocLinks: NOCLink[] = [];
        const dramLinks: DRAMLink[] = [];
        const ethernetLinks: EthernetLink[] = [];
        const pcieLinks: PCIELink[] = [];

        o.nocLinks.forEach((l: Object) => nocLinks.push(NOCLink.fromJSON(l, nodeMap)));
        o.dramLinks.forEach((l: Object) => dramLinks.push(DRAMLink.fromJSON(l, nodeMap)));
        o.ethernetLinks.forEach((l: Object) => ethernetLinks.push(EthernetLink.fromJSON(l, nodeMap)));
        o.pcieLinks.forEach((l: Object) => pcieLinks.push(PCIELink.fromJSON(l, nodeMap)));

        const device: Device = new Device(
            system,
            deviceUniqueId,
            o.name,
            o.type,
            o.loc,
            o.shape,
            computeNodes,
            nodeMap,
            nodeMapLoc,
            o.nocCount,
            nocLinks,
            dramLinks,
            ethernetLinks,
            pcieLinks,
        );

        // Set parent
        computeNodes.forEach((n: ComputeNode) => {
            n.device = device;
        });

        return device;
    }
}

/** A link from src ComputeNode to somewhere else */
export class Link {
    src: ComputeNode;

    maxBW: number;

    constructor(src: ComputeNode, maxBW: number) {
        this.src = src;
        console.assert(src !== undefined);
        this.maxBW = maxBW;
    }

    loc(): DeviceCr {
        return this.src.loc;
    }
}

/** Link between compute nodes, on a single NOC */
export class NOCLink extends Link {
    uniqueId: string;

    nocId: number;

    dest: ComputeNode;

    wrap: boolean;

    constructor(uniqueId: string, src: ComputeNode, dest: ComputeNode, nocId: number, maxBW: number, wrap: boolean) {
        super(src, maxBW);
        this.dest = dest;
        this.nocId = nocId;
        this.wrap = wrap;
        this.uniqueId = uniqueId;

        if (Math.abs(src.loc.x - dest.loc.x) > 1 || Math.abs(src.loc.y - dest.loc.y) > 1) {
            this.wrap = true;
        }
    }

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>): NOCLink {
        const src = nodeMap.get(o.src);
        const dest = nodeMap.get(o.dest);
        if (!src || !dest) {
            throw Error('Invalid src or dest compute node in NOC link');
        }

        return new NOCLink(o.uniqueId, src, dest, o.nocId, o.maxBW, o.wrap);
    }

    /* getStringName() : string {
    const dstLoc = this.dest.loc;
    const srcLoc = this.loc();
    let r = "";
    if ( (this.wrap && (dstLoc.x == 0)) || (!this.wrap && (dstLoc.x > srcLoc.x)) )  r = "right";
    if ( (this.wrap && (srcLoc.x == 0)) || (!this.wrap && (dstLoc.x < srcLoc.x)) )  r = "left";
    if ( (this.wrap && (dstLoc.y == 0)) || (!this.wrap && (dstLoc.y > srcLoc.y)) )  r = "down";
    if ( (this.wrap && (srcLoc.y == 0)) || (!this.wrap && (dstLoc.y < srcLoc.y)) )  r = "up";
    r += "_" + this.loc().y + "_" + this.loc().x;
    return r;
  } */
}

/** Link to DRAM channel */
export class DRAMLink extends Link {
    dramChannel: number;

    constructor(src: ComputeNode, dramChannel: number, maxBW: number) {
        super(src, maxBW);
        this.dramChannel = dramChannel;
    }

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>): DRAMLink {
        return new DRAMLink(nodeMap[o.src], o.dramChannel, o.maxBW);
    }
}

/** Link to DRAM channel */
export class EthernetLink extends Link {
    destUniqueId: string; /* destination unique ID... we don't have the pointer at construction time */

    dest?: ComputeNode; // to be populated later

    srcDevice(): Device {
        return this.src.device;
    }

    destDevice(): Device {
        return this.dest!.device;
    }

    constructor(src: ComputeNode, destUniqueId: string, maxBW: number) {
        super(src, maxBW);
        this.destUniqueId = destUniqueId;
    }

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>): EthernetLink {
        return new EthernetLink(nodeMap[o.src], o.destUniqueId, o.maxBW);
    }
}

export class PCIELink extends Link {
    constructor(src: ComputeNode, maxBW: number) {
        super(src, maxBW);
    }

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>): PCIELink {
        return new PCIELink(nodeMap[o.src], o.maxBW);
    }
}

/** Type of ComputeNode */
export enum ComputeNodeType {
    NONE = 'None',
    TENSIX = 'Tensix',
    CPU = 'CPU',
    DRAM = 'DRAM',
    ETHERNET = 'Ethernet',
    PCIE = 'PCIe',
}

/** Single compute node, which could be a CPU, Tensix, dram, ethernet, etc. */
export class ComputeNode {
    uniqueId: string;

    type: ComputeNodeType;

    computeNodeLoc: ComputeNodeLoc;

    loc: DeviceCr;

    device: Device;

    memorySize: number;
    // TODO: other properties could go here

    static fromJSON(o: Object, deviceUniqueId: number, systemUniqueId: number): ComputeNode {
        const r = Object.assign(new ComputeNode(), o);

        switch (o.type) {
            case 'tensix':
                r.type = ComputeNodeType.TENSIX;
                break;
            case 'cpu':
                r.type = ComputeNodeType.CPU;
                break;
            case 'dram':
                r.type = ComputeNodeType.DRAM;
                break;
            case 'ethernet':
                r.type = ComputeNodeType.ETHERNET;
                break;
            case 'pcie':
                r.type = ComputeNodeType.PCIE;
                break;
            case 'none':
                r.type = ComputeNodeType.NONE;
                break;
        }

        r.loc = o.loc;
        r.computeNodeLoc = new ComputeNodeLoc(
            { x: r.loc.x, y: r.loc.y },
            { x: 0, y: deviceUniqueId },
            { x: 0, y: systemUniqueId },
        );
        return r;
    }
}

/** Co-ordinate shapes for various hierarchy levels */
export interface SystemCr {
    x: number;
    y: number;
}
export interface DeviceCr {
    x: number;
    y: number;
}
