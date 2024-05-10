// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import { array, assert, boolean, enums, number, object, string, tuple } from './superstruct_export';

// Define JSON schema

const SystemCrVal = object({
    x: number(),
    y: number(),
});

const DeviceCrVal = object({
    x: number(),
    y: number(),
});

const NOCLinkVal = object({
    uniqueId: string(),
    src: string(),
    dest: string(),
    nocId: number(),
    maxBW: number(),
    wrap: boolean(),
});

const ComputeNodeVal = object({
    uniqueId: string(),
    type: enums(['tensix', 'cpu', 'dram', 'ethernet', 'pcie', 'none']),
    memorySize: number(),
    loc: DeviceCrVal,
});

const DRAMLinkVal = object({
    src: string(),
    maxBW: number(),
    dramChannel: number(),
});

const EthernetLinkVal = object({
    src: string(),
    maxBW: number(),
    destUniqueId: string(),
});

const PCIELinkVal = object({
    src: string(),
    maxBW: number(),
});

const DeviceVal = object({
    uniqueId: number(),
    name: string(),
    type: string(),
    loc: SystemCrVal,
    shape: DeviceCrVal,
    computeNodes: array(ComputeNodeVal),
    nocCount: number(),
    nocLinks: array(NOCLinkVal),
    dramLinks: array(DRAMLinkVal),
    ethernetLinks: array(EthernetLinkVal),
    pcieLinks: array(PCIELinkVal),
});

const SystemVal = object({
    uniqueId: number(),
    name: string(),
    type: string(),
    shape: SystemCrVal,
    devices: array(DeviceVal),
});

const ComputeGridVal = object({
    systems: array(SystemVal),
});

const UniqueLocVal = object({
    compute_node: DeviceCrVal,
    device: SystemCrVal,
    system: SystemCrVal,
});

const CoreOpVal = object({
    opUniqueId: number(),
    name: string(),
    uniqueId: number(),
    location: UniqueLocVal,
    epoch: number(),
    inputUniqueIds: array(number()),
    outputUniqueIds: array(number()),
});

const PerfDataVal = object({
    cycles: number(),
    propagated_cycles: number(),
    input_bw_ideal: array(number()),
    input_bw_got: array(number()),
    input_bw_prop: array(number()),
    output_bw_ideal: array(number()),
    output_bw_prop: array(number()),
});

const OpVal = object({
    uniqueId: number(),
    name: string(),
    type: string(),
    streaming: boolean(),
    perf: PerfDataVal,
    inputUniqueIds: array(number()),
    outputUniqueIds: array(number()),
});

const PathVal = object({
    idealBW: number(),
    propBW: number(),
    links: array(string()), // array of unique IDs
});

const PipeVal = object({
    uniqueId: number(),
    name: string(),
    location: UniqueLocVal,
    epoch: number(),
    inputUniqueIds: array(number()),
    outputUniqueIds: array(number()),
    paths: array(PathVal),
});

const BufferVal = object({
    uniqueId: number(),
    name: string(),
    location: UniqueLocVal,
    epoch: number(),
    size: number(),
    inputUniqueIds: array(number()),
    outputUniqueIds: array(number()),
});

const RoutingGraphVal = object({
    buffers: array(BufferVal),
    pipes: array(PipeVal),
    coreOps: array(CoreOpVal),
});

const ModuleVal = object({
    // type: string(), // TODO
    uniqueId: number(),
    name: string(),
    ops: array(OpVal),
    routingGraph: RoutingGraphVal,
});

const WorkloadVal = object({
    name: string(),
    modules: array(ModuleVal),
});

// Disabling errors on "Object". We're ok with using it, since we'll validate it with superstruct.
/* eslint-disable @typescript-eslint/ban-types */
export const validateComputeGrid = (o: Object): void => {
    assert(o, ComputeGridVal);
};

export const validateWorkload = (o: Object): void => {
    assert(o, WorkloadVal);
};
