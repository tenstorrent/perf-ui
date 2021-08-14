// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import path from 'path';
import fs from 'fs';

import {
    JsonObject,
    MultiRootedRecordTree,
    PerfDumpModes,
    getEpochId,
    getGraphId,
    getJsonData,
    isNumber,
    lastElement,
    parseOpIdentifier,
} from './perf_utils';
import PerfDumpFolderMap from './folder_map';

export default class PerfDumpData {
    siliconData: Map<string, Record<string, any>> | null;

    modelData: Map<string, Record<string, any>> | null;

    graphData: Map<string, string> | null;

    hostData: Map<string, Record<string, any>> | null;

    folderMap: PerfDumpFolderMap;

    static fromPerfPostprocessJson(epochName: string, jsonData: JSON): PerfDumpData {
        const siliconData = new Map([[epochName, jsonData]]);
        const tempFolderMap: MultiRootedRecordTree = { [epochName]: {} };
        const folderMap = new PerfDumpFolderMap(tempFolderMap);
        return new PerfDumpData(siliconData, null, null, null, folderMap);
    }

    constructor(
        siliconData: Map<string, Record<string, any>> | null,
        modelData: Map<string, Record<string, any>> | null,
        graphData: Map<string, string> | null,
        hostData: Map<string, Record<string, any>> | null,
        folderMap: PerfDumpFolderMap,
    ) {
        this.siliconData = siliconData;
        this.setCoreOpIds();
        this.modelData = modelData;
        this.graphData = graphData;
        this.hostData = hostData;
        this.setHostEventIds();
        this.setHostDataBounds();
        this.updateSiliconDataWithHostNumbers();
        this.setPerfBoundsSiliconData();
        this.folderMap = folderMap;
        console.log('CONSTRUCTED PERF DUMP: ', this);
    }

    setHostEventIds(): void {
        if (!this.hostData) {
            return;
        }
        let index = 0;
        for (const hostPath of this.hostData.keys()) {
            for (const hostEventData of Object.values(this.hostData.get(hostPath)!)) {
                hostEventData['event-id'] = `${index}`;
                index += 1;
            }
        }
    }

    setCoreOpIds(): void {
        if (!this.siliconData) {
            return;
        }
        let index = 0;
        for (const folderPath of this.siliconData.keys()) {
            let graphId = getGraphId(folderPath);
            let epochId = '';
            if (graphId === '') {
                graphId = 'N/A';
                epochId = getEpochId(folderPath);
                if (epochId === '') {
                    console.error("perf dump data: Couldn't find graph id or epoch id, shouldn't happen!");
                    continue;
                }
            }
            for (const [opName, opData] of Object.entries(this.siliconData.get(folderPath)!)) {
                const [name, _x, _y] = parseOpIdentifier(opName);
                if (name !== '') {
                    opData['core-op-id'] = `${index}`;
                    index += 1;
                }
            }
        }
    }

    // assumes start and end times are in ascending order
    setHostDataBounds(): void {
        if (!this.hostData) {
            return;
        }
        for (const hostPath of this.hostData.keys()) {
            let minStart = Infinity;
            let maxEnd = 0;
            for (const [hostEventName, hostEventData] of Object.entries(this.hostData.get(hostPath)!)) {
                const startTimes = hostEventData.start;
                const endTimes = hostEventData.end;
                if (
                    !Array.isArray(startTimes) ||
                    !Array.isArray(endTimes) ||
                    startTimes.length === 0 ||
                    endTimes.length === 0
                ) {
                    continue;
                }
                console.assert(
                    startTimes.length === endTimes.length,
                    `Start and end times should have the same length for host event ${hostEventName}.`,
                );
                minStart = Math.min(minStart, startTimes[0]);
                maxEnd = Math.max(maxEnd, lastElement(endTimes));
            }
            this.hostData.get(hostPath)!['min-start'] = minStart;
            this.hostData.get(hostPath)!['max-end'] = maxEnd;
        }
    }

    updateSiliconDataWithHostNumbers(): void {
        if (!this.hostData || !this.siliconData) {
            return;
        }
        const deviceRuntimeRegex = /^device-runtime-device-(\d+)(.*)$/;
        const deviceStartRegex = /^device-start-cycle-aligned-device-(\d+)(.*)$/;
        const deviceEndRegex = /^device-end-cycle-aligned-device-(\d+)(.*)$/;
        for (const hostPath of this.hostData.keys()) {
            const folderPathHostData = this.hostData.get(hostPath);
            console.assert(
                folderPathHostData,
                'Host path not found as a key in host data populate host to device map.',
            );
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
            // // if we have more than 1 device, we only have one device runtime event that indicates earliest start to latest end device.
            // // Right now, we are using the earliest start time/latest ent time of the recorded device as an estimate of the start time/end time for every device
            // // Also, we are using AICLK as the derived clock frequency.
            // // TODO: update when we have run time for every device
            // if (deviceIds.length > 1) {
            //   let minStartNs = Infinity;
            //   if (!isNumber(startNs)) return;
            //   for (const deviceId of deviceIds) {
            //     for (const dataPath of this.siliconData.keys()) {
            //       // find the aiclk (in Ghz) of each device that is correlated with host data under hostpath
            //       if (!dataPath.startsWith(hostParentPath) || this.siliconData.get(dataPath)!["per-epoch-events"]["device-id"] != deviceId) {
            //         continue;
            //       }
            //       const startCycle = folderPathHostData![Object.keys(folderPathHostData!).find(key => new RegExp("device-start-cycle-aligned-device-" + deviceId + ".*").test(key))!];
            //       const deviceRuntime = Object.keys(folderPathHostData!).find((eventName: string) => RegExp("device-end-cycle-aligned-device-" + deviceId + ".*").test(eventName));
            //       const startNs = deviceRuntime ? parseInt(folderPathHostData![deviceRuntime]["start"]) : null;
            //       if (startNs != null) {
            //         if (startNs < minStartNs) {
            //           minStartNs = startNs;
            //         }
            //       }
            //       const validStartCycle = startCycle != undefined && isNumber(parseInt(startCycle["value"]));
            //       if (!validStartCycle) break;
            //       // temporary (before we dump actual data for each device in host)
            //       const clockFrequency = this.siliconData.get(dataPath)!["per-epoch-events"]["AICLK"] / 1000;
            //       console.assert(clockFrequency, "Invalid AICLK");
            //       this.siliconData.get(dataPath)!["derived-device-clock-frequency"] = clockFrequency;
            //       this.siliconData.get(dataPath)!["device-start-cycle"] = parseInt(startCycle["value"]);
            //       this.siliconData.get(dataPath)!["start-ns"] = startNs;
            //     }
            //   }
            // }
            // else if (deviceIds.length == 1) {
            // const deviceId = deviceIds[0];
            let earliestDevice = '';
            let earliestRuntime = Infinity;
            for (const deviceId of deviceIds) {
                const runTime =
                    folderPathHostData![
                        Object.keys(folderPathHostData!).find((key) =>
                            new RegExp(`device-runtime-device-${deviceId}_.*`).test(key),
                        )!
                    ];
                const runtimeStart = parseInt(runTime.start);
                if (runtimeStart < earliestRuntime) {
                    earliestRuntime = runtimeStart;
                    earliestDevice = deviceId;
                }
            }
            console.assert(earliestDevice !== '');
            console.assert(earliestRuntime !== Infinity);
            const deviceId = earliestDevice;
            for (const dataPath of this.siliconData.keys()) {
                // find the aiclk (in Ghz) of each device that is correlated with host data under hostpath
                if (
                    !dataPath.startsWith(hostParentPath) ||
                    this.siliconData.get(dataPath)!['per-epoch-events']['device-id'] !== deviceId
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
                const validStartCycle = startCycle !== undefined && isNumber(parseInt(startCycle.value));
                const validEndCycle = endCycle !== undefined && isNumber(parseInt(endCycle.value));
                if (!validRunTime || !validStartCycle || !validEndCycle) {
                    break;
                }
                const clockFrequency =
                    (parseInt(endCycle.value) - parseInt(startCycle.value)) /
                    (parseInt(runTime.end) - parseInt(runTime.start));
                this.siliconData.get(dataPath)!['derived-device-clock-frequency'] = clockFrequency;
                this.siliconData.get(dataPath)!['device-start-cycle'] = parseInt(startCycle.value);
                this.siliconData.get(dataPath)!['device-start-ns'] = parseInt(runTime.start);
            }
            // }
        }
    }

    // assumes start and end times are in ascending order
    setPerfBoundsSiliconData(): void {
        if (!this.siliconData) {
            return;
        }
        for (const folderPath of this.siliconData.keys()) {
            let minStart = Infinity;
            let maxEnd = 0;
            let graphId = getGraphId(folderPath);
            let epochId = '';
            if (graphId === '') {
                graphId = 'N/A';
                epochId = getEpochId(folderPath);
                if (epochId === '') {
                    console.error("perf dump data: Couldn't find graph id or epoch id, shouldn't happen!");
                    continue;
                }
            }
            for (const [opName, opData] of Object.entries(this.siliconData.get(folderPath)!)) {
                const [name, _x, _y] = parseOpIdentifier(opName);
                if (name === '') {
                    continue;
                }
                const ncriscData = opData.NCRISC ? opData.NCRISC : {};
                const dramReadRegex = /^dram-read-stream-(\d+)-(\d+)$/;
                const dramWriteSentRegex = /^dram-write-sent-stream-(\d+)-(\d+)$/;
                const dramWriteClearedRegex = /^dram-write-tile-cleared-stream-(\d+)$/;
                for (const field of Object.keys(ncriscData)) {
                    if (dramReadRegex.test(field)) {
                        if (
                            Array.isArray(ncriscData[field]['chunk-read-issued']) &&
                            ncriscData[field]['chunk-read-issued'].length > 0
                        ) {
                            minStart = Math.min(minStart, ncriscData[field]['chunk-read-issued'][0]);
                            maxEnd = Math.max(maxEnd, lastElement(ncriscData[field]['chunk-read-issued'])!);
                        }
                        if (
                            Array.isArray(ncriscData[field]['tiles-flushed']) &&
                            ncriscData[field]['tiles-flushed'].length > 0
                        ) {
                            minStart = Math.min(minStart, ncriscData[field]['tiles-flushed'][0]);
                            maxEnd = Math.max(maxEnd, lastElement(ncriscData[field]['chunk-read-issued'])!);
                        }
                    } else if (
                        dramWriteSentRegex.test(field) &&
                        Array.isArray(ncriscData[field].end) &&
                        ncriscData[field].end.length > 0
                    ) {
                        minStart = Math.min(minStart, ncriscData[field].end[0]);
                        maxEnd = Math.max(maxEnd, lastElement(ncriscData[field].end)!);
                    } else if (
                        dramWriteClearedRegex.test(field) &&
                        Array.isArray(ncriscData[field].end) &&
                        ncriscData[field].end.length > 0
                    ) {
                        minStart = Math.min(minStart, ncriscData[field].end[0]);
                        maxEnd = Math.max(maxEnd, lastElement(ncriscData[field].end)!);
                    }
                }
                // wait for tile
                const dataT0 = opData.T0 ? opData.T0 : {};
                const waitForTileRegex = /^wait-for-incoming-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                for (const field of Object.keys(dataT0)) {
                    const m = field.match(waitForTileRegex);
                    if (m != null) {
                        const starts = dataT0[field].start;
                        const ends = dataT0[field].end;
                        if (
                            !Array.isArray(starts) ||
                            !Array.isArray(ends) ||
                            starts.length != ends.length ||
                            starts.length == 0 ||
                            ends.length == 0
                        ) {
                            continue;
                        }
                        minStart = Math.min(minStart, starts[0], ends[0]);
                        maxEnd = Math.max(maxEnd, lastElement(starts), lastElement(ends));
                    }
                }

                // wait for free tile
                const dataT2 = opData.T2 ? opData.T2 : {};
                const waitForFreeTileRegex = /^wait-for-free-tiles-outer-loop-(\d+)-operand-(\d+)-num-tiles-(\d+)$/;
                for (const field of Object.keys(dataT2)) {
                    const m = field.match(waitForFreeTileRegex);
                    if (m != null) {
                        const starts = dataT2[field].start;
                        const ends = dataT2[field].end;
                        if (
                            !Array.isArray(starts) ||
                            !Array.isArray(ends) ||
                            starts.length !== ends.length ||
                            starts.length === 0 ||
                            ends.length === 0
                        ) {
                            continue;
                        }
                        minStart = Math.min(minStart, starts[0], ends[0]);
                        maxEnd = Math.max(maxEnd, lastElement(starts), lastElement(ends));
                    }
                }

                const perThreadEvents = opData['per-thread-events'] ? opData['per-thread-events'] : {};
                const inputRegex = /^input-(\d+)$/;
                for (const input of Object.keys(perThreadEvents)) {
                    if (inputRegex.test(input)) {
                        const unpackerFirstBlockDataAvailable =
                            perThreadEvents[input]['unpacker-first-block-data-available'] ||
                            perThreadEvents[input]['unpack-first-block-data-available'];
                        const packFinishLastOuterLoop =
                            perThreadEvents[input]['pack-finish-last-outer-loop'] ||
                            perThreadEvents[input]['pack-end-outer-loop'];
                        if (isNumber(unpackerFirstBlockDataAvailable)) {
                            minStart = Math.min(minStart, unpackerFirstBlockDataAvailable);
                        }
                        if (isNumber(packFinishLastOuterLoop)) {
                            maxEnd = Math.max(maxEnd, packFinishLastOuterLoop);
                        }
                    }
                }
            }

            const folderPathSiliconData = this.siliconData.get(folderPath)!;
            folderPathSiliconData['perf-dump-min-start-cycles'] = minStart;
            folderPathSiliconData['perf-dump-max-end-cycles'] = maxEnd;

            if (!this.hostData) {
                continue;
            }

            const deviceStartCycle = folderPathSiliconData['device-start-cycle'];
            const deviceStartNs = folderPathSiliconData['device-start-ns'];
            const clockFrequency = folderPathSiliconData['derived-device-clock-frequency'];
            const AICLK = folderPathSiliconData['per-epoch-events'].AICLK / 1000;
            const minStartNsDerived = (minStart - deviceStartCycle) * (1 / clockFrequency) + deviceStartNs;
            const minStartNsAICLK = (minStart - deviceStartCycle) * (1 / AICLK) + deviceStartNs;
            const maxEndNsDerived = (maxEnd - deviceStartCycle) * (1 / clockFrequency) + deviceStartNs;
            const maxEndNsAICLK = (maxEnd - deviceStartCycle) * (1 / AICLK) + deviceStartNs;
            if (
                isNumber(minStartNsDerived) &&
                isNumber(minStartNsAICLK) &&
                isNumber(maxEndNsDerived) &&
                isNumber(maxEndNsAICLK)
            ) {
                folderPathSiliconData['perf-dump-min-start-ns-derived'] = minStartNsDerived;
                folderPathSiliconData['perf-dump-min-start-ns-aiclk'] = minStartNsAICLK;
                folderPathSiliconData['perf-dump-max-end-ns-derived'] = maxEndNsDerived;
                folderPathSiliconData['perf-dump-max-end-ns-aiclk'] = maxEndNsAICLK;
            }
        }
    }

    clear(): void {
        this.siliconData && this.siliconData.clear();
        this.modelData && this.modelData.clear();
        this.graphData && this.graphData.clear();
        this.hostData && this.hostData.clear();
    }

    // for local selection
    static fromFolder(dir: string): PerfDumpData {
        // const fs = require('fs');
        // const path = require('path');
        // data file name regex
        const dumpRegex = /^perf_postprocess.json$/;
        const dumpRegexSpatial1 = /^perf_postprocess_epoch_(\d+).json$/;
        const modelRegex = /^runtime_table.json$/;
        const modelRegexSpatial1 = /^runtime_table_epoch_(\d+).json$/;
        const graphRegex = /^perf_graph_(\S+).dot$/;
        const hostJsonRegex = /^(.*)proc_(\d+).json$/;

        const isValidFile = (filePath: string): boolean => {
            const file = path.basename(filePath);
            return (
                dumpRegex.test(file) ||
                dumpRegexSpatial1.test(file) ||
                modelRegex.test(file) ||
                modelRegexSpatial1.test(file) ||
                graphRegex.test(file)
            );
        };

        // dir is the directory the user selected starting from root, folderPath is the folders appended to dir that leads to host
        const setHostData = (dir: string, folderPath: string[], hostData: Map<string, any>): void => {
            console.log('SETTING HOST DATA', dir, folderPath, hostData);
            const hostPath = path.join(dir, ...folderPath);
            const filePaths = fs
                .readdirSync(hostPath)
                .map((file: string) => path.join(hostPath, file))
                .filter(
                    (filePath: string) =>
                        hostJsonRegex.test(path.basename(filePath)) && fs.lstatSync(filePath).isFile(),
                );
            const getHostJsonData = (filePath: string): JsonObject => {
                const rawData = fs.readFileSync(path.resolve(filePath));
                const jsonData: JsonObject = JSON.parse(rawData.toString());
                if (!jsonData) {
                    return {};
                }
                const process = path.basename(filePath).match(hostJsonRegex)![2];
                for (const hostEventData of Object.values(jsonData)) {
                    if (!hostEventData) {
                        console.error('Unexpected host event json data.');
                        continue;
                    }
                    hostEventData['process-id'] = process;
                }
                return jsonData;
            };
            let jsonData = {};
            for (const filePath of filePaths) {
                jsonData = {
                    ...jsonData,
                    ...getHostJsonData(filePath),
                };
            }
            if (folderPath.length > 0) {
                hostData.set(folderPath.join('/'), jsonData);
            }

            // special case where user selects host directly
            if (folderPath.length == 0) {
                hostData.set('host', jsonData);
            }
            // console.log("HOST JSON DATA: ", hostData);
        };
        // data maps
        let siliconData: Map<string, Record<string, any>> | null = new Map<string, Record<string, any>>();
        let modelData: Map<string, Record<string, any>> | null = new Map<string, Record<string, any>>();
        let graphData: Map<string, string> | null = new Map<string, string>();
        let hostData: Map<string, any> | null = new Map<string, any>();
        const folderMap = PerfDumpFolderMap.fromFolder(dir);
        console.log('FOLDER MAP: ', folderMap);

        // handle special case where user selects a directory directly containing data files.
        if (folderMap.mode === PerfDumpModes.SINGLE_DIR) {
            // retrieve all subdirectories under data path, and then from those directories filter out
            // the files we are interested in
            const filePaths = fs
                .readdirSync(dir)
                .map((file: string) => path.join(dir, file))
                .filter((filePath: string) => isValidFile(filePath) && fs.statSync(filePath).isFile());

            const dataKey = path.basename(dir);

            for (const filePath of filePaths) {
                const file = path.basename(filePath);
                if (dumpRegex.test(file) || dumpRegexSpatial1.test(file)) {
                    const jsonData = getJsonData(path.resolve(filePath));
                    if (Object.keys(jsonData).length > 0) {
                        siliconData.set(dataKey, jsonData);
                    }
                } else if (modelRegex.test(file) || modelRegexSpatial1.test(file)) {
                    const jsonData = getJsonData(path.resolve(filePath));
                    if (Object.keys(jsonData).length > 0) {
                        modelData.set(dataKey, jsonData);
                    }
                } else if (graphRegex.test(file)) {
                    const dot = fs.readFileSync(path.resolve(filePath)).toString();
                    graphData.set(dataKey, dot);
                }
            }
            // remove data that doesn't have corresponding silicon data from model and graph
            for (const key of modelData.keys()) {
                if (!siliconData.has(key)) {
                    modelData.delete(key);
                }
            }
            for (const key of graphData.keys()) {
                if (!siliconData.has(key)) {
                    graphData.delete(key);
                }
            }
            if (siliconData.size === 0) {
                siliconData = null;
            }
            if (modelData.size === 0) {
                modelData = null;
            }
            if (graphData.size === 0) {
                graphData = null;
            }
            // if user selected single directory then there shouldn't be host data
            return new PerfDumpData(siliconData, modelData, graphData, null, folderMap);
        }
        // handle special case where user selects host directly.
        if (folderMap.mode === PerfDumpModes.SINGLE_HOST_DIR) {
            setHostData(dir, [], hostData);
            return new PerfDumpData(null, null, null, hostData, folderMap);
        }

        for (const folderPath of folderMap.allFolderPaths) {
            if (lastElement(folderPath) === 'host') {
                setHostData(dir, folderPath, hostData);
                continue;
            }
            const pathToData = path.join(dir, ...folderPath);
            // retrieve all subdirectories under data path, and then from those directories filter out
            // the files we are interested in
            const filePaths = fs
                .readdirSync(pathToData)
                .map((file: string) => path.join(pathToData, file))
                .filter((filePath: string) => isValidFile(filePath) && fs.lstatSync(filePath).isFile());

            const dataKey = folderMap.getDataKey(folderPath);
            for (const filePath of filePaths) {
                const file = path.basename(filePath);
                if (dumpRegex.test(file) || dumpRegexSpatial1.test(file)) {
                    const jsonData = getJsonData(path.resolve(filePath));
                    if (Object.keys(jsonData).length > 0) {
                        siliconData.set(dataKey, jsonData);
                    }
                } else if (modelRegex.test(file) || modelRegexSpatial1.test(file)) {
                    const jsonData = getJsonData(path.resolve(filePath));
                    if (Object.keys(jsonData).length > 0) {
                        modelData.set(dataKey, jsonData);
                    }
                } else if (graphRegex.test(file)) {
                    const dot = fs.readFileSync(path.resolve(filePath)).toString();
                    graphData.set(dataKey, dot);
                }
            }
        }
        // remove data that doesn't have corresponding silicon data from model and graph
        for (const key of modelData.keys()) {
            if (!siliconData.has(key)) {
                modelData.delete(key);
            }
        }
        for (const key of graphData.keys()) {
            if (!siliconData.has(key)) {
                graphData.delete(key);
            }
        }
        if (siliconData.size === 0) {
            siliconData = null;
        }
        if (modelData.size === 0) {
            modelData = null;
        }
        if (graphData.size === 0) {
            graphData = null;
        }
        if (hostData.size === 0) {
            hostData = null;
        }
        return new PerfDumpData(siliconData, modelData, graphData, hostData, folderMap);
    }
}
