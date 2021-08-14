// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

/**
 * Classes that represent placement and routing of workload on compute grid
 */

// Disabling errors on "Object". We're ok with using it, since we'll validate it with superstruct.
/* eslint-disable @typescript-eslint/ban-types */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { ComputeNode, ComputeNodeLoc, Device, NOCLink } from './compute_grid';

import { validateWorkload } from './json_validate';

/** Full list of modules in a workload */
export class Workload {
    name: string;

    modules: Module[];

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>, linkMap: Map<string, NOCLink>): Workload {
        // Validate json
        validateWorkload(o);

        const r = new Workload();
        r.name = o.name;
        r.modules = [];
        o.modules.forEach((c: Object) => r.modules.push(Module.fromJSON(c, nodeMap, linkMap)));
        return r;
    }

    // Return all ops on given device, given epoch
    filterOps(device: Device, epoch: number): Op[] {
        const ops: Op[] = [];
        this.modules.forEach((m: Module) => {
            m.ops.forEach((op: Op) => {
                op.coreOps.every((coreOp: CoreOp) => {
                    if (coreOp.computeNode.device == device && coreOp.epoch == epoch) {
                        ops.push(op);
                        return false; // at least one core op matches, push the whole op, stop filtering
                    }
                    return true;
                });
            });
        });
        return ops;
    }

    // Return all buffers on a given device
    filterBuffers(device: Device, epoch: number): Buffer[] {
        const buffers: Buffer[] = [];
        this.modules.forEach((m: Module) => {
            buffers.push(...m.buffers.filter((b: Buffer) => b.owner.device == device && b.epoch == epoch));
        });
        return buffers;
    }

    // Return all pipes on a given device
    filterPipes(device: Device, epoch: number): Pipe[] {
        const pipes: Pipe[] = [];
        const buffers: Buffer[] = this.filterBuffers(device, epoch);
        this.modules.forEach((m: Module) => {
            pipes.push(
                ...m.pipes.filter(
                    (p: Pipe) =>
                        p.start.some((b: Buffer) => buffers.includes(b)) ||
                        p.end.some((b: Buffer) => buffers.includes(b)),
                ),
            );
        });
        return pipes;
    }

    // Return list of epochs on given device
    availableEpochs(device: Device): number[] {
        const epochs: number[] = [];
        this.modules.forEach((m: Module) => {
            m.ops.forEach((op: Op) => {
                op.coreOps.forEach((coreOp: CoreOp) => {
                    if (coreOp.computeNode.device == device && !epochs.includes(coreOp.epoch)) {
                        epochs.push(coreOp.epoch);
                    }
                });
            });
        });
        return epochs.sort();
    }
}

/** Single workload module that's placed as a unit on one or more systems. Could be the full model, or some part of it. */
export class Module {
    /** Type is the name in implementation, i.e. SelfAttention */
    type: string;

    /** Name is instance name... encoder0_SelfAttention, for example */
    name: string;

    /** List of devices on which this Module is placed */
    devices: Device[];

    /** List of ops in this module */
    ops: Op[];

    /** List of queues */
    queues: Queue[];

    /** List of parameters */
    parameters: Parameter[];

    /** List of inputs */
    inputs: ModuleInput[];

    /** List of submodules */
    submodules: Module[];

    /** List of buffers in this module */
    buffers: Buffer[];

    /** List of pipes in this module */
    pipes: Pipe[];

    constructor(type: string, name: string) {
        this.type = type;
        this.name = name;
        this.ops = [];
        this.buffers = [];
        this.pipes = [];
        this.queues = [];
        this.parameters = [];
        this.inputs = [];
    }

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>, linkMap: Map<string, NOCLink>): Module {
        const r = new Module(/* o["type"] */ 'module_type', o.name);

        const graphNodeMap = new Map<number, TTGraphNode>();
        o.ops.forEach((c: Object) => {
            if (c.type == 'Input') {
                const q = ModuleInput.fromJSON(c, r);
                graphNodeMap.set(q.uniqueId, q);
                r.inputs.push(q);
            } else if (c.type == 'BudaDramQueue') {
                const q = Queue.fromJSON(c, r);
                graphNodeMap.set(q.uniqueId, q);
                r.queues.push(q);
            } else if (c.type == 'Parameter') {
                const p = Parameter.fromJSON(c, r);
                graphNodeMap.set(p.uniqueId, p);
                r.parameters.push(p);
            } else {
                const op = Op.fromJSON(c, r);
                graphNodeMap.set(op.uniqueId, op);
                r.ops.push(op);
            }
        });

        // Add connectivity in graphNodeMap
        graphNodeMap.forEach((gn: TTGraphNode) => gn.parseConnectivity(graphNodeMap));

        const rg = o.routingGraph;
        rg.buffers.forEach((c: Object) => r.buffers.push(Buffer.fromJSON(c, nodeMap)));

        const bufferMap = new Map(r.buffers.map((b: Buffer): [number, Buffer] => [b.uniqueId, b]));
        rg.pipes.forEach((c: Object) => r.pipes.push(Pipe.fromJSON(c, bufferMap, linkMap)));

        const pipeMap = new Map(r.pipes.map((p: Pipe): [number, Pipe] => [p.uniqueId, p]));
        const opMap = new Map(r.ops.map((op: Op): [number, Op] => [op.uniqueId, op]));

        const coreOps: CoreOp[] = [];
        rg.coreOps.forEach((c: Object) => {
            const co = CoreOp.fromJSON(c, nodeMap, bufferMap);
            const op = opMap.get(co.parentId);
            if (!op) {
                throw `CoreOp's parent ID ${co.parentId} not found${JSON.stringify(co)}`;
            }
            op.coreOps.push(co);
            co.parentOp = op;
            coreOps.push(co);
        });

        const coreOpMap = new Map(coreOps.map((coreOp: CoreOp): [number, CoreOp] => [coreOp.uniqueId, coreOp]));
        r.buffers.forEach((b: Buffer, index: number) => b.setProdConsFromJSON(rg.buffers[index], coreOpMap, pipeMap));

        return r;
    }

    getGraphNodes(): TTGraphNode[] {
        return [...this.ops, ...this.queues, ...this.parameters, ...this.inputs];
    }
}

export class PerfData {
    cycles: number; // ideal cycle count per core

    propCycles: number; // propagated cycle count based on propagated input BW vs. desired

    // per operand
    idealInputBW: number[]; // input BW needed for full perf

    gotInputBW: number[]; // input BW received if input ops were producing at ideal speed

    propInputBW: number[]; // input BW received through propagated calculation

    // per output
    idealOutputBW: number[];

    propOutputBW: number[];

    roundArray(a: number[]): number[] {
        return a.map((n: number) => Math.round(n * 10) / 10);
    }

    constructor(o: Object) {
        this.cycles = o.cycles;
        this.propCycles = o.propagated_cycles;
        this.idealInputBW = this.roundArray(o.input_bw_ideal);
        this.gotInputBW = this.roundArray(o.input_bw_got);
        this.propInputBW = this.roundArray(o.input_bw_prop);
        this.idealOutputBW = this.roundArray(o.output_bw_ideal);
        this.propOutputBW = this.roundArray(o.output_bw_prop);
    }
}

/** TT Graph node - Op, Queue, or Parameter */
export class TTGraphNode {
    uniqueId: number;

    /** Parent module */
    module: Module;

    /** Attributes */
    name: string;

    type: string;

    /** Inputs/Outputs */
    inputUniqueIds: number[];

    outputUniqueIds: number[];

    inputs: TTGraphNode[];

    outputs: TTGraphNode[];

    constructor(
        uniqueId: number,
        name: string,
        type: string,
        module: Module,
        inputUniqueIds: number[],
        outputUniqueIds: number[],
    ) {
        this.uniqueId = uniqueId;
        this.name = name;
        this.type = type;
        this.module = module;
        this.inputs = [];
        this.outputs = [];
        this.inputUniqueIds = inputUniqueIds;
        this.outputUniqueIds = outputUniqueIds;
    }

    parseConnectivity(graphNodeMap: Map<number, TTGraphNode>): void {
        this.inputUniqueIds.forEach((c: number) => {
            const n = graphNodeMap.get(c);
            if (!n) {
                throw `Invalid node id in input list for node ${this.name} (${this.uniqueId})`;
            }
            this.inputs.push(n);
        });

        this.outputUniqueIds.forEach((c: number) => {
            const n = graphNodeMap.get(c);
            if (!n) {
                throw `Invalid node id in output list for node ${this.name} (${this.uniqueId})`;
            }
            this.outputs.push(n);
        });
    }
}

/** Module Input */
export class ModuleInput extends TTGraphNode {
    constructor(
        uniqueId: number,
        module: Module,
        name: string,
        type: string,
        inputUniqueIds: number[],
        outputUniqueIds: number[],
    ) {
        super(uniqueId, name, type, module, inputUniqueIds, outputUniqueIds);
    }

    static fromJSON(c: Object, parent: Module): ModuleInput {
        return new ModuleInput(c.uniqueId, parent, c.name, c.type, c.inputUniqueIds, c.outputUniqueIds);
    }
}

/** Input / Output Queue */
export class Queue extends TTGraphNode {
    constructor(
        uniqueId: number,
        module: Module,
        name: string,
        type: string,
        inputUniqueIds: number[],
        outputUniqueIds: number[],
    ) {
        super(uniqueId, name, type, module, inputUniqueIds, outputUniqueIds);
    }

    static fromJSON(c: Object, parent: Module): Queue {
        return new Queue(c.uniqueId, parent, c.name, c.type, c.inputUniqueIds, c.outputUniqueIds);
    }
}

/** Parameter / constant */
export class Parameter extends TTGraphNode {
    constructor(
        uniqueId: number,
        module: Module,
        name: string,
        type: string,
        inputUniqueIds: number[],
        outputUniqueIds: number[],
    ) {
        super(uniqueId, name, type, module, inputUniqueIds, outputUniqueIds);
    }

    static fromJSON(c: Object, parent: Module): Parameter {
        return new Parameter(c.uniqueId, parent, c.name, c.type, c.inputUniqueIds, c.outputUniqueIds);
    }
}

/** A Buda or CPU op */
export class Op extends TTGraphNode {
    /** Attributes */
    perf: PerfData;

    streaming: boolean;

    /** Ops running on single cores */
    coreOps: CoreOp[];

    constructor(
        uniqueId: number,
        module: Module,
        name: string,
        type: string,
        streaming: boolean,
        inputUniqueIds: number[],
        outputUniqueIds: number[],
        perf: Object,
    ) {
        super(uniqueId, name, type, module, inputUniqueIds, outputUniqueIds);
        this.streaming = streaming;
        this.perf = new PerfData(perf);
    }

    static fromJSON(o: Object, parent: Module): Op {
        const r = new Op(o.uniqueId, parent, o.name, o.type, o.streaming, o.inputUniqueIds, o.outputUniqueIds, o.perf);
        r.coreOps = [];
        // o["coreOps"].forEach( (c: Object) => r.coreOps.push(CoreOp.fromJSON(c, r, nodeMap)) );
        return r;
    }

    // TODO: implement a better one
    toJSON(): Object {
        /* return Object.getOwnPropertyNames(this).reduce((a, b) => {
      a[b] = this[b];
      return a;
    }, {}); */
        return {
            name: this.name,
            type: this.type,
            module: this.module.name,
            streaming: this.streaming,
            coreOps: this.coreOps.map((coreOp: CoreOp) => ({
                loc: coreOp.computeNode.loc,
                epoch: coreOp.epoch,
            })),
        };
    }
}

/** A part of the op assigned to a single core */
export class CoreOp {
    uniqueId: number;

    name: string;

    /** Compute node that his op is on */
    computeNode: ComputeNode;

    /** Epoch */
    epoch: number;

    /** Inputs and outputs */
    inputBuffers: Buffer[];

    outputBuffers: Buffer[];

    /** Parent Op */
    parentId: number;

    parentOp: Op;

    /** Fixed rotation anchor for place & route */
    rotateAnchor: boolean;

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>, bufferMap: Map<number, Buffer>): CoreOp {
        const r = new CoreOp();
        r.uniqueId = o.uniqueId;
        r.name = o.name;
        r.epoch = o.epoch;
        const cn = nodeMap.get(ComputeNodeLoc.fromJSON(o.location).key());
        if (!cn) {
            throw `Compute node for core op found ${JSON.stringify(o)}`;
        }
        r.computeNode = cn;
        r.inputBuffers = [];
        r.outputBuffers = [];
        r.parentId = o.opUniqueId;
        r.rotateAnchor = false;

        o.inputUniqueIds &&
            o.inputUniqueIds.forEach((c: number) => {
                const b = bufferMap.get(c);
                if (!b) {
                    throw `Invalid buffer id in core op${o.toString()}`;
                }
                r.inputBuffers.push(b);
            });

        o.outputUniqueIds &&
            o.outputUniqueIds.forEach((c: number) => {
                const b = bufferMap.get(c);
                if (!b) {
                    throw `Invalid output buffer id in core op${o.toString()}`;
                }
                r.outputBuffers.push(b);
            });

        return r;
    }
}

export class Buffer {
    uniqueId: number;

    name: string;

    owner: ComputeNode;

    epoch: number;

    size: number;

    producerCoreOp: CoreOp;

    producerPipe: Pipe;

    consumerCoreOps: CoreOp[];

    consumerPipes: Pipe[];

    constructor(uniqueId: number, name: string, owner: ComputeNode, size: number, epoch: number) {
        this.uniqueId = uniqueId;
        this.name = name;
        this.owner = owner;
        this.size = size;
        this.epoch = epoch;
        this.consumerCoreOps = [];
        this.consumerPipes = [];
    }

    static fromJSON(o: Object, nodeMap: Map<string, ComputeNode>): Buffer {
        const owner = nodeMap.get(ComputeNodeLoc.fromJSON(o.location).key());
        if (!owner) {
            throw `Invalid owner for buffer ${JSON.stringify(o)}`;
        }
        const r = new Buffer(o.uniqueId, o.name, owner, o.size, o.epoch);
        return r;
    }

    // Set producer/consumer after creation, since we don't have full pipe map until after buffers are created
    setProdConsFromJSON(o: Record<string, any>, coreOpMap: Map<number, CoreOp>, pipeMap: Map<number, Pipe>): void {
        o.inputUniqueIds &&
            o.inputUniqueIds.forEach((c: number) => {
                const p = pipeMap.get(c);
                if (p) {
                    this.producerPipe = p;
                } else {
                    const co = coreOpMap.get(c);
                    if (!co) {
                        throw `Invalid input ID ${c} for buffer ${JSON.stringify(o)}`;
                    }
                    this.producerCoreOp = co;
                }
            });

        o.outputUniqueIds &&
            o.outputUniqueIds.forEach((c: number) => {
                const p = pipeMap.get(c);
                if (p) {
                    this.consumerPipes.push(p);
                } else {
                    const co = coreOpMap.get(c);
                    if (!co) {
                        throw `Invalid output ID ${c} for buffer ${JSON.stringify(o)}`;
                    }
                    this.consumerCoreOps.push(co);
                }
            });
    }
}

export class Pipe {
    uniqueId: number;

    name: string;

    start: Buffer[];

    end: Buffer[];

    paths: Path[];

    constructor(uniqueId: number, name: string) {
        this.uniqueId = uniqueId;
        this.name = name;
    }

    static fromJSON(o: Object, bufferMap: Map<number, Buffer>, linkMap: Map<string, NOCLink>): Pipe {
        const r = new Pipe(o.uniqueId, o.name);

        r.start = [];
        r.end = [];

        r.paths = [];
        o.paths.forEach((o: Object) => r.paths.push(Path.fromJSON(o, linkMap, r)));

        o.inputUniqueIds &&
            o.inputUniqueIds.forEach((c: number) => {
                const b = bufferMap.get(c);
                if (!b) {
                    throw `Invalid buffer ID ${c} in core op${JSON.stringify(o)}`;
                }
                r.start.push(b);
            });

        o.outputUniqueIds &&
            o.outputUniqueIds.forEach((c: number) => {
                const b = bufferMap.get(c);
                if (!b) {
                    throw `Invalid output buffer ID ${c} in core op${JSON.stringify(o)}`;
                }
                r.end.push(b);
            });

        return r;
    }

    getLinks(): NOCLink[] {
        return this.paths.reduce((prev: NOCLink[], p: Path) => [...prev, ...p.links], []);
    }
}

export class Path {
    pipe: Pipe;

    idealBW: number;

    propBW: number;

    links: NOCLink[];

    constructor(idealBW: number, propBW: number, parentPipe: Pipe) {
        this.propBW = Math.round(propBW * 10.0) / 10.0;
        this.idealBW = Math.round(idealBW * 10.0) / 10.0;
        this.pipe = parentPipe;
    }

    bw(propagatedBWs: boolean): number {
        return propagatedBWs ? this.propBW : this.idealBW;
    }

    static fromJSON(o: Object, linkMap: Map<string, NOCLink>, parentPipe: Pipe): Path {
        const r = new Path(o.idealBW, o.propBW, parentPipe);
        r.links = [];
        // o["links"].forEach( (s: string) => {
        // Hack for json dumper producing duplicate links
        [...new Set<string>(o.links)].forEach((s: string) => {
            const link = linkMap.get(s);
            if (!link) {
                throw `Invalid link ID ${s} in path ${JSON.stringify(o)}`;
            }
            r.links.push(link);
        });
        return r;
    }
}
