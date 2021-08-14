// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import fs from 'fs';

import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Button, Icon, Tag, TreeNodeInfo } from '@blueprintjs/core';
import { Tooltip2 } from '@blueprintjs/popover2';
import { saveAs } from 'file-saver';
import * as htmlToImage from 'html-to-image';

import PerfDumpData from './data_loader';
import {
    FolderPathSequence,
    Frequency,
    IPerfResults,
    IVisContext,
    PerfDumpVisProps,
    SelectionChangeHandler,
    TreeAction,
    Unit,
    arrayDiff,
    folderTreeReducer,
    getAllCores,
    getAllInputs,
    getFrequencyText,
    isHostDirectory,
    isNumber,
    lastElement,
} from './perf_utils';
import PerfWelcome from './perf_welcome';
import { localFileSelect } from './perf_local_select';

import PerfConsole from './perf_console';

import { debounce } from '../common';
import { syncRemotePerfDump } from '../network';
import { ConsoleLine } from '../spatial_gui/console_text';

import {
    CapturePerfButton,
    DisplayDramReadWrite,
    FolderTree,
    FrequencyAlert,
    FrequencySelect,
    GraphModeSwitch,
    InputMenu,
    ModelNumberSwitch,
    NcriscCoreMenu,
    NcriscFieldMenu,
    NcriscModeSwitch,
    PerCoreModeSwitch,
    ShowFolderTreeSwitch,
    ToggleBarRegionHeight,
    UnitSelect,
    XYOrderSwitch,
} from './components';

import { SetErrorContext, WorkspaceContext } from '../context';
import {
    D3Controller,
    GraphD3Controller,
    NcriscD3Controller,
    PerCoreD3Controller,
    PerfDumpD3Controller,
} from './d3_controllers';
import { NcriscDumpVisProps } from './types';
import { BAR_THRESHOLD, MAX_PLOTTED_ELEMENTS } from './constants';
import PerfDumpFolderMap from './folder_map';

/* eslint-disable @typescript-eslint/ban-types */

// Wrapper that either shows file chooser or the actual perf dump
const PerfDumpWrapper: React.FC<{}> = () => {
    const workspace = React.useContext(WorkspaceContext);
    const setError = React.useContext(SetErrorContext);

    // Set buttons to loading (spinning) when waiting for remote perf dump data
    const [isLoadingPerfData, setIsLoadingPerfData] = useState<boolean>(false);
    // Whether we loaded the data from workspace or a selected file/folder, used for reload button
    const [loadedFromWorkspace, setLoadedFromWorkspace] = useState<boolean>(false);
    // Path we loaded the data from, reload will fetch the data from the same path
    const [lastRemoteLoad, setLastRemoteLoad] = useState<IPerfResults | null>(null);
    const [lastLocalLoad, setLastLocalLoad] = useState<string>('');
    // Perf dump data, wraps silicon data, model data, and folder map
    const [perfData, setPerfData] = useState<PerfDumpData | null>(null);
    const [selectedPerfResults, setSelectedPerfResults] = useState<IPerfResults | null>(null);
    const [initialVisProps, setInitialVisProps] = useState<PerfDumpVisProps | null>(null);

    // load and parse workspace perf json into perf data
    const loadPerfResults = async (perfResults: IPerfResults): Promise<PerfDumpData> => {
        let resultsPath = perfResults.path.slice(0, perfResults.path.indexOf('/perf_results'));
        if (workspace && workspace.remote) {
            resultsPath = await syncRemotePerfDump(workspace, perfResults);
        }
        return PerfDumpData.fromFolder(resultsPath);
    };

    // call readPerfDumpFolder to load and parse data, then handle success/error
    const handleWorkspacePerfDumpSelect = async (
        selectedResults: IPerfResults,
        visProps?: PerfDumpVisProps,
    ): Promise<void> => {
        console.log('Handling remote perf select for: ', selectedResults);
        const folderpath = selectedResults.path;
        if (folderpath === '') {
            setError(
                'Please select a valid directory. No options available could mean the workspace directory does not contain perf_results.',
            );
            return;
        }
        setIsLoadingPerfData(true);
        try {
            const loadedData = await loadPerfResults(selectedResults);
            setInitialVisProps(visProps || null);
            setSelectedPerfResults(selectedResults);
            setPerfData(loadedData);
            setIsLoadingPerfData(false);
            setLoadedFromWorkspace(true);
            setLastRemoteLoad(selectedResults);
        } catch (err: any) {
            console.error('Error loading perf dump: ', err);
            setIsLoadingPerfData(false);
            setLoadedFromWorkspace(false);
            setError(err.toString(), false);
        }
    };

    const handleLocalPerfDumpSelect = async (
        perfDump: PerfDumpData,
        selectedName: string,
        visProps?: PerfDumpVisProps,
    ): Promise<void> => {
        console.log('Handling local perf select...');
        setLoadedFromWorkspace(false);
        setLastLocalLoad(selectedName);
        setInitialVisProps(visProps || null);
        setSelectedPerfResults({ testname: selectedName, path: selectedName });
        setPerfData(perfDump);
        setIsLoadingPerfData(false);
    };

    // function for reloading local data
    const handleLocalReload = async (visProps?: PerfDumpVisProps): Promise<void> => {
        console.log(`Loading from local (${lastLocalLoad})`);
        // const selectedName = path.basename(lastLocalLoad);
        setIsLoadingPerfData(true);
        if (!fs.existsSync(lastLocalLoad)) {
            setIsLoadingPerfData(false);
            throw Error(`Directory to reload does not exist: ${lastLocalLoad}`);
        } else if (fs.statSync(lastLocalLoad).isDirectory()) {
            // Use a promise to yield control (and allow react to propagate state) before loading
            const perfDumpData = await new Promise<PerfDumpData>((resolve, _reject) => {
                resolve(PerfDumpData.fromFolder(lastLocalLoad));
            });
            handleLocalPerfDumpSelect(perfDumpData, lastLocalLoad, visProps);
        } else if (fs.statSync(lastLocalLoad).isFile()) {
            const perfDumpData = await localFileSelect(lastLocalLoad);
            handleLocalPerfDumpSelect(perfDumpData, lastLocalLoad, visProps);
        } else {
            setIsLoadingPerfData(false);
            throw Error('Invalid directory passed to reload.');
        }
    };

    const handleClose = (): void => {
        setInitialVisProps(null);
        setSelectedPerfResults(null);
        setPerfData(null);
    };

    return (
        <div>
            {!perfData && (
                <PerfWelcome
                    handleLocalDataLoaded={handleLocalPerfDumpSelect}
                    handleSelectWorkspacePerfDumpTest={handleWorkspacePerfDumpSelect}
                    isLoadingPerfData={isLoadingPerfData}
                    setIsLoadingPerfData={setIsLoadingPerfData}
                />
            )}
            {perfData && (
                <PerfDump
                    perfDumpData={perfData}
                    perfResultsMeta={selectedPerfResults}
                    initialVisProps={initialVisProps}
                    loadedFromWorkspace={loadedFromWorkspace}
                    onReload={async (visProps: PerfDumpVisProps) => {
                        if (loadedFromWorkspace) {
                            if (!selectedPerfResults) {
                                throw new Error("Can't reload without selected perf results.");
                            }
                            await handleWorkspacePerfDumpSelect(selectedPerfResults, visProps);
                        } else {
                            await handleLocalReload(visProps);
                        }
                    }}
                    handleClose={handleClose}
                />
            )}
        </div>
    );
};

const createDeviceFrequencyMap = (
    siliconData: Map<string, Record<string, any>>,
    hostData: Map<string, Record<string, any>>,
): Map<string, Record<number, Record<string, number>>> | null => {
    const deviceFrequencyMap = new Map<string, Record<number, Record<string, number>>>();
    for (const hostPath of hostData.keys()) {
        deviceFrequencyMap.set(hostPath, {});
        const hostParentPath = hostPath.split('/').slice(0, -1).join('/');
        const folderPathHostData = hostData.get(hostPath);
        for (const folderPath of siliconData.keys()) {
            // check if dump is correlated with host path
            if (!folderPath.startsWith(hostParentPath)) {
                continue;
            }
            const deviceId = siliconData.get(folderPath)!['per-epoch-events']['device-id'];
            // already have frequency info for this device id
            if (deviceFrequencyMap.get(hostPath)![deviceId] !== undefined) {
                continue;
            }
            const { AICLK } = siliconData.get(folderPath)!['per-epoch-events'];
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

            if (
                !runTime ||
                !startCycle ||
                !endCycle ||
                !isNumber(parseInt(runTime.start)) ||
                !isNumber(parseInt(runTime.end)) ||
                !isNumber(parseInt(startCycle.value)) ||
                !isNumber(parseInt(endCycle.value))
            ) {
                continue;
            }

            // calculate clock frequency in GHz (cycles/nanosecond)
            const clockFrequency =
                (parseInt(endCycle.value) - parseInt(startCycle.value)) /
                (parseInt(runTime.end) - parseInt(runTime.start));
            // TODO: add runner info (Versim Silicon)
            if (isNumber(clockFrequency)) {
                deviceFrequencyMap.get(hostPath)![deviceId] = {};
                deviceFrequencyMap.get(hostPath)![deviceId].AICLK = AICLK / 1000;
                deviceFrequencyMap.get(hostPath)![deviceId]['derived-frequency'] = clockFrequency;
            }
        }
        // if no device data recorded, delete host path
        if (Object.keys(deviceFrequencyMap.get(hostPath)!).length === 0) {
            deviceFrequencyMap.delete(hostPath);
        }
    }
    return deviceFrequencyMap.size > 0 ? deviceFrequencyMap : null;
};

const pushToLines = (lines: ConsoleLine[], c: ConsoleLine) => {
    return [...lines, c];
};

const generateInitialVisProps = (
    persistPreviousState: PerfDumpVisProps | null,
    siliconData: Map<string, Record<string, any>> | null,
    folderMap: PerfDumpFolderMap,
    dimensions: { height: number; width: number },
    folderTreeWidth: number,
    pushToConsole: (consoleLine: ConsoleLine) => void,
): PerfDumpVisProps => {
    const warnNotExists = (itemType: string, itemName: string) => {
        pushToConsole({
            content: (
                <p className="console-warning">
                    Previously selected {itemType}{' '}
                    <Tag round minimal>
                        {itemName}
                    </Tag>{' '}
                    no longer exists.
                </p>
            ),
        });
    };
    const allInputs = getAllInputs(siliconData, folderMap.allFolderPaths);
    const dims = { width: dimensions.width - 100 - folderTreeWidth, height: dimensions.height - 340 };

    if (persistPreviousState !== null) {
        // Handle state persistence

        // Remove unselectable folder paths
        const folderPathsComparable = folderMap.allFolderPaths.map((folderPath) => folderPath.join('/'));
        persistPreviousState.selectedFolderPaths = persistPreviousState.selectedFolderPaths.filter((folderPath) => {
            const present = folderPathsComparable.includes(folderPath.join('/'));
            if (!present) {
                warnNotExists('folder', folderPath.at(-1) || '[unknown]');
            }
            return present;
        });

        // Reset selectable inputs
        persistPreviousState.selectableInputs = getAllInputs(siliconData, persistPreviousState.selectedFolderPaths);

        // Remove unselectable inputs
        persistPreviousState.selectedInputs = persistPreviousState.selectedInputs.filter((input) => {
            const present = persistPreviousState.selectableInputs.includes(input);
            if (!present) {
                warnNotExists('input', input);
            }
            return present;
        });

        // Use previous settings/selections
        console.log('Loading plot with previous settings/selections', persistPreviousState);
        return {
            ...persistPreviousState,
            // Always reset these:
            ...dims,
            allInputs,
        };
    }
    const selectedFolderPaths = folderMap.allFolderPaths.filter((folderPath) => isHostDirectory(folderPath.join('/')));
    const selectableInputs = getAllInputs(siliconData, selectedFolderPaths);
    return {
        ...dims,
        unit: Unit.CYCLES,
        frequency: Frequency.DERIVED,
        showModelNumbers: false,
        showAllDramReads: false,
        showAllDramWrites: false,
        barRegionHeight: 15,
        allInputs,
        selectableInputs,
        selectedFolderPaths,
        selectedInputs: selectableInputs.length > 0 ? [selectableInputs[0]] : [],
        xyOrder: false,
    };
};

let d3Controller: D3Controller | null = null;
// let d3ControllerDefault: PerfDumpD3 | null = null;
// let d3ControllerNcrisc: NcriscDumpD3 | null = null;
// let d3ControllerPerCore: PerfDumpD3PerCore | null = null;

interface IPerfGraph {
    graphPlot: React.ReactElement;
    graphMode: boolean;
}

const PerfGraph = ({ graphPlot, graphMode }: IPerfGraph): React.ReactElement => {
    if (graphMode) {
        return graphPlot;
    }

    return <div />;
};

interface IPerfDump {
    perfDumpData: PerfDumpData;
    perfResultsMeta: IPerfResults | null;
    initialVisProps: PerfDumpVisProps | null;
    handleClose: () => void;
    loadedFromWorkspace: boolean;
    onReload: (visProps: PerfDumpVisProps) => Promise<void>;
}

const PerfDump: React.FC<IPerfDump> = ({
    perfDumpData,
    perfResultsMeta,
    initialVisProps,
    handleClose,
    loadedFromWorkspace,
    onReload,
}) => {
    console.log('#### Rendering PerfDump Component ####');
    const { siliconData, modelData, graphData, hostData, folderMap } = perfDumpData;
    const deviceFrequencyMap = hostData && siliconData ? createDeviceFrequencyMap(siliconData, hostData) : null;
    const d3Ref = useRef<HTMLDivElement>(null);
    const graphRef = useRef(null);
    const [version, setVersion] = useState('');
    const [outputText, pushToOutput] = useReducer(pushToLines, []);
    const [consoleText, pushToConsole] = useReducer(pushToLines, []);

    // // add hotkeys when needed
    // const hotkeys = useMemo(() => [
    // ], []);

    // const { handleKeyDown, handleKeyUp } = useHotkeys(hotkeys);

    const [perCoreMode, setPerCoreMode] = useState(false);
    const [ncriscMode, setNcriscMode] = useState(false); // ncrisc panel toggle
    const [reloading, setReloading] = useState(false);
    const [graphMode, setGraphMode] = useState(false); // graph panel toggle
    const [graphPlot, setGraphPlot] = useState(<div />); // react component describing the plotted graph
    const [folderTreeWidth, setFolderTreeWidth] = useState(300);
    const [dimensions, setDimensions] = useState({
        height: window.innerHeight,
        width: window.innerWidth,
    });
    const [showFolderTree, setShowFolderTree] = useState(true);
    const [numPlottedElements, setNumPlottedElements] = useState(0);

    const [visProps, setVisProps] = useState<PerfDumpVisProps>(() =>
        generateInitialVisProps(initialVisProps, siliconData, folderMap, dimensions, folderTreeWidth, pushToConsole),
    );
    const [isTreeSyncedWithSelection, setIsTreeSyncedWithSelection] = useState(false);

    const setSelectedFolderPaths: SelectionChangeHandler = (
        selectedFolderPaths: FolderPathSequence[],
        shouldResyncTree = false,
    ) => {
        if (shouldResyncTree) {
            setIsTreeSyncedWithSelection(false);
        }
        setVisProps({ ...visProps, selectedFolderPaths });
    };

    const [folderTree, folderTreeDispatch] = React.useReducer(folderTreeReducer, folderMap.treeNodes);

    // console.log("VisProps In Perf Dump: ", visProps);
    const [firstSelect, setFirstSelect] = useState(true);
    const [alertFrequency, setAlertFrequency] = useState(false);
    // shouldUpdate controls whether or not we should run specific useEffects.
    // Sometimes we already created a new component with the newest updates, in this case, running those useEffects would be a waste of time.
    const [shouldUpdate, setShouldUpdate] = useState(true);

    // console states
    const [cmdValue, setCmdValue] = useState('');
    const [tabId, setTabId] = useState('tab-console');

    const imgRef = useRef<HTMLImageElement>(null);
    const [consoleHistory, setConsoleHistory] = useState<string[]>([]);
    const [consoleIndex, setConsoleIndex] = useState(0);
    const [selectedLabel, setSelectedLabel] = useState('');

    const allFields = [
        'Show All Fields',
        'Total Epoch',
        'Epoch Prologue',
        'Epoch Loop',
        'Epoch Epilogue',
        'Qslot Complete',
        'Dram Read',
        'Dram Write',
        'Buffer Status',
        'Misc Info',
    ];
    const [ncriscVisProps, setNcriscVisProps] = useState<NcriscDumpVisProps>({
        allFields,
        allCores: [],
        selectedFields: allFields.slice(1, 5),
        selectedCores: [],
    });

    /** Context object that contains state and callbacks for use with folder tree reducer
     * This helps to keep the reducer function decoupled from component scope
     */
    const visContext: IVisContext = {
        allFolderPaths: folderMap.allFolderPaths,
        visProps,
        numPlottedElements: d3Controller ? d3Controller.getNumPlottedElements() : 0,
        onSelectionChange: setSelectedFolderPaths,
        pushToConsole,
    };

    const [screenCaptureLoading, setScreenCaptureLoading] = useState(false);
    const [showNumBars, setShowNumBars] = useState(false);

    const isHostSelected = useMemo(
        () =>
            visProps.selectedFolderPaths.some((folderPath: string[]) => lastElement(folderPath) === 'host') ||
            !siliconData,
        [visProps.selectedFolderPaths, siliconData],
    );

    const isDeviceSelected = useMemo(
        () => visProps.selectedFolderPaths.some((folderPath: string[]) => lastElement(folderPath) !== 'host'),
        [visProps.selectedFolderPaths],
    );

    if (!isTreeSyncedWithSelection) {
        setIsTreeSyncedWithSelection(true);
        console.log('#### Syncing folder tree nodes with selections');
        folderTreeDispatch({
            payload: { path: [0], isExpanded: true },
            type: 'SET_IS_EXPANDED',
            context: visContext,
        });

        // Ensure all selected paths in vis state are selected in the folder tree
        visProps.selectedFolderPaths.forEach((folderPath: string[]) => {
            const path: number[] = [];
            let currentTier = folderTree;
            if (
                currentTier.length === 1 &&
                currentTier[0].className === 'perf_results' &&
                folderPath[0] !== 'perf_results'
            ) {
                // Special case: "perf_results" is not included in the folder paths but it is the root node
                // TODO: Ensure that folder map always includes the root node
                currentTier = currentTier[0].childNodes || [];
            }
            // Follow the path down the tree
            folderPath
                .map((dir, i): [string, number] => [dir, i])
                .forEach(([currentDir, i]) => {
                    const matchingNode = currentTier.find((node: TreeNodeInfo) => node.className === currentDir);
                    if (!matchingNode) {
                        if (currentDir === 'perf_results') {
                            return;
                        }
                        throw Error(
                            `The path [${folderPath}] does not exist in the folder tree (at '${currentDir}' in [${currentTier.map(
                                (node) => node.className,
                            )}]).`,
                        );
                    }
                    path.push(currentTier.indexOf(matchingNode));
                    if (!matchingNode.childNodes || matchingNode.childNodes.length === 0) {
                        // Terminal node
                        if (i < folderPath.length - 1) {
                            throw Error(
                                `Mismatch between folder path and folder tree: ${matchingNode} is a terminal node, but ${folderPath} contains additional entries.`,
                            );
                        }
                        folderTreeDispatch({
                            type: 'NODE_ONLY_SELECT',
                            payload: {
                                node: matchingNode,
                                path,
                            },
                            context: visContext,
                        });
                    } else {
                        if (!matchingNode.isExpanded) {
                            const currentPath = [...path];
                            folderTreeDispatch({
                                type: 'SET_IS_EXPANDED',
                                payload: {
                                    path: currentPath,
                                    isExpanded: true,
                                },
                                context: visContext,
                            });
                        }
                        currentTier = matchingNode.childNodes;
                    }
                });
        });
    }

    const showNumBars1 = () => {
        if (!showNumBars || !d3Controller || d3Controller instanceof GraphD3Controller) {
            setShowNumBars(false);
            return;
        }
        pushToConsole({ content: <p>&nbsp;</p> });
        pushToConsole({
            content: (
                <p>
                    <span style={{ color: '#FFFF00' }}>Warning: </span>
                    Excessive number of elements plotted (currently:{' '}
                    <span style={{ color: '#00FFFF' }}>{d3Controller.getNumBars()}</span>), may cause lag in the gui.
                </p>
            ),
        });
        setShowNumBars(false);
    };

    const resultsName = (perfResultsMeta ? perfResultsMeta.testname : '') + (loadedFromWorkspace ? '' : ' (Local)');

    const screenCaptureFunction = () => {
        if (!d3Controller) {
            return;
        }
        const minHeight = d3.select('.pd-perf-dump-content').style('min-height');
        const maxHeight = d3.select('.pd-perf-dump-content').style('max-height');
        d3.select('.pd-perf-dump-content')
            .style('min-height', `${d3Controller.FULL_H + 40}px`)
            .style('max-height', `${d3Controller.FULL_H + 40}px`);

        d3.select('.Footer').style('display', 'none');

        const screenshotTarget = document.body;

        /* eslint-disable promise/always-return, promise/catch-or-return */
        htmlToImage.toPng(screenshotTarget).then((dataUrl) => {
            saveAs(dataUrl, 'perf-snapshot.png');
            d3.select('.pd-perf-dump-content').style('min-height', minHeight).style('max-height', maxHeight);

            d3.select('.Footer').style('display', 'inline-block');
        });
        /* eslint-enable */
    };

    const createD3 = () => {
        console.log('Creating D3');
        if (ncriscMode || perCoreMode || graphMode) {
            return;
        }
        if (d3Ref.current == null) {
            console.log('Null d3Ref');
            return;
        }
        if (d3Controller != null) {
            d3Controller.close(); // clean up
            d3Controller = null;
        }
        const newInputOptions = getAllInputs(siliconData, visProps.selectedFolderPaths);
        const newSelectedInputs: string[] = [];
        // unselect the inputs that are not an option anymore
        visProps.selectedInputs.forEach(
            (input: string) => newInputOptions.includes(input) && newSelectedInputs.push(input),
        );
        // if we don't have any input selected, select the first input
        if (newSelectedInputs.length === 0 && newInputOptions.length > 0) {
            newSelectedInputs.push(newInputOptions[0]);
        }
        newSelectedInputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
        const newVisProps = { ...visProps };
        let updateSelectableInputs = false;
        let updateSelectedInputs = false;
        if (arrayDiff(visProps.selectableInputs, newInputOptions).length > 0) {
            newVisProps.selectableInputs = newInputOptions;
            updateSelectableInputs = true;
        }
        if (arrayDiff(visProps.selectedInputs, newSelectedInputs).length > 0) {
            newVisProps.selectedInputs = newSelectedInputs;
            updateSelectedInputs = true;
        }
        // if selected inputs were updated, then the input update useEffect will fire, which is redundant.
        if (updateSelectedInputs) {
            setShouldUpdate(false);
        }
        if (updateSelectableInputs || updateSelectableInputs) {
            setVisProps(newVisProps);
        }
        console.log('recreating');
        d3Controller = new PerfDumpD3Controller(
            d3Ref.current,
            newVisProps,
            folderMap,
            siliconData,
            modelData,
            hostData,
        );
        if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
            setShowNumBars(true);
        }
    };

    const createNcriscD3 = () => {
        if (!ncriscMode) {
            return;
        }

        if (d3Controller != null) {
            d3Controller.close(); // clean up
            d3Controller = null;
        }

        const [coreOptions, cores] = getAllCores(siliconData, visProps.selectedFolderPaths, ncriscMode);
        const newNcriscVisProps = {
            ...ncriscVisProps,
            allCores: coreOptions,
            selectedCores: cores,
        };
        // updating ncrisc props will fire the ncrisc props update useEffect
        setShouldUpdate(false);
        setNcriscVisProps(newNcriscVisProps);
        console.log('creating a new ncrisc dump d3 component');
        const newInputOptions = getAllInputs(siliconData, visProps.selectedFolderPaths);
        const newSelectedInputs: string[] = [];
        // unselect the inputs that are not an option anymore
        visProps.selectedInputs.forEach(
            (input: string) => newInputOptions.includes(input) && newSelectedInputs.push(input),
        );
        // if we don't have any input selected, select the first input
        if (newSelectedInputs.length === 0 && newInputOptions.length > 0) {
            newSelectedInputs.push(newInputOptions[0]);
        }
        newSelectedInputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
        const newVisProps = { ...visProps };
        let updateSelectableInputs = false;
        let updateSelectedInputs = false;
        if (arrayDiff(visProps.selectableInputs, newInputOptions).length > 0) {
            newVisProps.selectableInputs = newInputOptions;
            updateSelectableInputs = true;
        }
        if (arrayDiff(visProps.selectedInputs, newSelectedInputs).length > 0) {
            newVisProps.selectedInputs = newSelectedInputs;
            updateSelectedInputs = true;
        }
        // if selected inputs were updated, then the input update useEffect will fire, which is redundant.
        if (updateSelectedInputs) {
            setShouldUpdate(false);
        }
        if (updateSelectableInputs || updateSelectableInputs) {
            setVisProps(newVisProps);
        }
        d3Controller = new NcriscD3Controller(
            d3Ref.current!,
            visProps,
            folderMap,
            newNcriscVisProps,
            siliconData!,
            hostData,
        );
        if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
            setShowNumBars(true);
        }
    };

    const createPerCoreD3 = () => {
        if (!perCoreMode) {
            return;
        }

        if (d3Ref.current == null) {
            console.log('Null d3Ref');
            return;
        }

        if (d3Controller != null) {
            d3Controller.close(); // clean up
            d3Controller = null;
        }

        console.log('Creating a new d3 per-core component.');
        const newInputOptions = getAllInputs(siliconData, visProps.selectedFolderPaths);
        const newSelectedInputs: string[] = [];
        // unselect the inputs that are not an option anymore
        visProps.selectedInputs.forEach(
            (input: string) => newInputOptions.includes(input) && newSelectedInputs.push(input),
        );
        // if we don't have any input selected, select the first input
        if (newSelectedInputs.length === 0 && newInputOptions.length > 0) {
            newSelectedInputs.push(newInputOptions[0]);
        }
        newSelectedInputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
        const newVisProps = { ...visProps };
        let updateSelectableInputs = false;
        let updateSelectedInputs = false;
        if (arrayDiff(visProps.selectableInputs, newInputOptions).length > 0) {
            newVisProps.selectableInputs = newInputOptions;
            updateSelectableInputs = true;
        }
        if (arrayDiff(visProps.selectedInputs, newSelectedInputs).length > 0) {
            newVisProps.selectedInputs = newSelectedInputs;
            updateSelectedInputs = true;
        }
        // if selected inputs were updated, then the input update useEffect will fire, which is redundant.
        if (updateSelectedInputs) {
            setShouldUpdate(false);
        }
        if (updateSelectableInputs || updateSelectableInputs) {
            setVisProps(newVisProps);
        }
        d3Controller = new PerCoreD3Controller(
            d3Ref.current,
            newVisProps,
            folderMap,
            siliconData!,
            modelData,
            hostData,
        );
        if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
            setShowNumBars(true);
        }
    };
    const createGraphD3 = (newVisProps = visProps) => {
        if (!graphMode || !graphData) {
            return;
        }

        if (d3Controller != null) {
            d3Controller.close(); // clean up
            d3Controller = null;
        }

        console.log('Creating a new Graph d3 component.');
        const newInputOptions = getAllInputs(siliconData, newVisProps.selectedFolderPaths);
        let newSelectedInputs: string[] = [];
        // unselect the inputs that are not an option anymore
        newVisProps.selectedInputs.forEach(
            (input: string) => newInputOptions.includes(input) && newSelectedInputs.push(input),
        );
        // if we don't have any input selected, select the first input
        if (newSelectedInputs.length === 0 && newInputOptions.length > 0) {
            newSelectedInputs.push(newInputOptions[0]);
        }
        newSelectedInputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
        newSelectedInputs = [newSelectedInputs[0]];
        const updatedVisProps = { ...newVisProps };
        let updateSelectableInputs = false;
        let updateSelectedInputs = false;
        if (arrayDiff(newVisProps.selectableInputs, newInputOptions).length > 0) {
            updatedVisProps.selectableInputs = newInputOptions;
            updateSelectableInputs = true;
        }
        if (arrayDiff(newVisProps.selectedInputs, newSelectedInputs).length > 0) {
            updatedVisProps.selectedInputs = newSelectedInputs;
            updateSelectedInputs = true;
        }
        // if selected inputs were updated, then the input update useEffect will fire, which is redundant.
        if (updateSelectedInputs) {
            setShouldUpdate(false);
        }
        if (updateSelectableInputs || updateSelectableInputs) {
            setVisProps(updatedVisProps);
        }
        d3Controller = new GraphD3Controller(
            graphRef.current!,
            updatedVisProps,
            (newState) => setGraphPlot(newState),
            siliconData!,
            modelData,
            graphData,
            hostData,
        );
    };

    // update dimensions on window size change
    useEffect(() => {
        const debouncedHandleResize = debounce(function handleResize() {
            setDimensions({
                height: window.innerHeight,
                width: window.innerWidth,
            });
        }, 100);

        window.addEventListener('resize', debouncedHandleResize);

        return () => {
            window.removeEventListener('resize', debouncedHandleResize);
        };
    });

    // only nanoseconds when host is selected
    useEffect(() => {
        if (isHostSelected && visProps.unit !== Unit.NS) {
            setVisProps({ ...visProps, unit: Unit.NS });
        }
    }, [isHostSelected, visProps]);

    // update selectable inputs (visprops.allinputs) and selected inputs (visprops.selectedInputs) when selected plots change
    useEffect(() => {
        // if host data selected, input selection and various other selections should be disabled.
        if (!siliconData) {
            if (d3Controller && d3Controller instanceof PerfDumpD3Controller) {
                d3Controller.updateFolderPaths(visProps);
            }
            return;
        }
        if (!ncriscMode && d3Controller && !(d3Controller instanceof NcriscD3Controller)) {
            const newInputOptions = getAllInputs(siliconData, visProps.selectedFolderPaths);
            const newSelectedInputs: string[] = [];
            // unselect the inputs that are not an option anymore
            if (Array.isArray(visProps.selectedInputs)) {
                visProps.selectedInputs.forEach(
                    (input: string) => newInputOptions.includes(input) && newSelectedInputs.push(input),
                );
            }
            // if we don't have any input selected, select the first input
            if (newSelectedInputs.length === 0 && Array.isArray(newInputOptions) && newInputOptions.length > 0) {
                newSelectedInputs.push(newInputOptions[0]);
            }
            newSelectedInputs.sort((a, b) => parseInt(a.split('-').pop()!) - parseInt(b.split('-').pop()!));
            const newVisProps = { ...visProps };
            let updateSelectableInputs = false;
            let updateSelectedInputs = false;
            if (arrayDiff(visProps.selectableInputs, newInputOptions).length > 0) {
                newVisProps.selectableInputs = newInputOptions;
                updateSelectableInputs = true;
            }
            if (arrayDiff(visProps.selectedInputs, newSelectedInputs).length > 0) {
                newVisProps.selectedInputs = newSelectedInputs;
                updateSelectedInputs = true;
            }
            // if selected inputs were updated, then the input update useEffect will fire, which is redundant.
            if (updateSelectedInputs) {
                setShouldUpdate(false);
            }
            if (updateSelectableInputs || updateSelectableInputs) {
                setVisProps(newVisProps);
            }
            if (!graphMode && d3Controller && !(d3Controller instanceof GraphD3Controller)) {
                d3Controller.updateFolderPaths(newVisProps);
                if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
                    setShowNumBars(true);
                }
            }
            createGraphD3(newVisProps);
        } else if (ncriscMode && d3Controller instanceof NcriscD3Controller) {
            const newNcriscVisProps = { ...ncriscVisProps };
            const [newCoreOptions, newSelectedCores] = getAllCores(
                siliconData,
                visProps.selectedFolderPaths,
                ncriscMode,
            );
            if (arrayDiff(ncriscVisProps.allCores, newCoreOptions).length > 0) {
                setShouldUpdate(false);
                newNcriscVisProps.allCores = newCoreOptions;
                newNcriscVisProps.selectedCores = newSelectedCores;
                setNcriscVisProps(newNcriscVisProps);
            }
            d3Controller.updateFolderPaths(visProps, newNcriscVisProps);
            if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
                setShowNumBars(true);
            }
        }
        if (d3Controller) {
            setNumPlottedElements(d3Controller.getNumPlottedElements());
        }
    }, [visProps.selectedFolderPaths]);

    // update width and height of visprops and height of folder tree on dimensions changes
    useEffect(() => {
        // if ncrisc mode, leave space for folder tree
        // if (ncriscMode) {
        //   width -= 300;
        // }
        d3.select('.folder-tree').style(
            'max-height',
            `${dimensions.height - (180 + 45) + PerfDumpD3Controller.MARGIN_SHIFT_DOWN}px`,
        );

        const height = !graphMode ? dimensions.height - (340 + 45) : dimensions.height - 180;
        const width = showFolderTree ? dimensions.width - folderTreeWidth : dimensions.width;

        setVisProps({ ...visProps, width: width - 100, height });
    }, [dimensions, graphMode]);

    // on show folder tree change, update folder tree display, update visprops width.
    useEffect(() => {
        const width = showFolderTree ? dimensions.width - folderTreeWidth : dimensions.width;
        d3.select('.folder-tree')
            .style('width', `${showFolderTree ? folderTreeWidth : 0}px`)
            .style('display', showFolderTree ? 'block' : 'none');
        setVisProps({ ...visProps, width: width - 100 });
    }, [showFolderTree]);

    // on visprops changes, update drag handler of folder tree resizer to match new vis props.
    // on show folder tree changes, update whether or not we allow dragging.
    useEffect(() => {
        const folderTreeElement = d3.select('.folder-tree');
        const resizer = d3.select<HTMLDivElement, any>('.folder-tree-resizer');
        if (showFolderTree) {
            resizer.style('cursor', 'col-resize');
        } else {
            resizer.style('cursor', 'default');
        }

        resizer
            .on('mouseover', function (this: d3.BaseType) {
                if (!showFolderTree) {
                    return;
                }
                d3.select(this).style('background-color', '#137cbd');
            })
            .on('mouseout', function (this: d3.BaseType) {
                if (!showFolderTree) {
                    return;
                }
                d3.select(this).style('background-color', null);
            });

        // update folder tree width on drag
        const dragResize = d3.drag<HTMLDivElement, any>().on('drag', function (this: d3.DraggedElementBaseType, event) {
            if (!showFolderTree) {
                return;
            }
            let x = d3.pointer(event, this!.parentNode)[0];
            x = Math.max(0, x);
            folderTreeElement.style('width', `${x}px`);

            setFolderTreeWidth(x);
            setVisProps({ ...visProps, width: window.innerWidth - 100 - x });
        });
        resizer.call(dragResize);
    }, [visProps, showFolderTree]);

    // based on mode selected, plot a specific d3 graph
    // useLayoutEffect(initializeD3Components, []);
    useEffect(() => {
        createD3();
        createNcriscD3();
        createPerCoreD3();
        createGraphD3();
    }, [ncriscMode, perCoreMode, graphMode]); // on data or visProps changes

    // update plot when selected inputs changes.
    useEffect(() => {
        if (!d3Controller || d3Controller instanceof NcriscD3Controller || ncriscMode) {
            return;
        }

        if (!shouldUpdate) {
            setShouldUpdate(true);
            return;
        }

        if (d3Controller instanceof GraphD3Controller) {
            console.assert(graphMode, 'd3 component instance of graphdumpd3 but graph mode is turned off.');
            d3Controller.update(visProps);
            return;
        }
        d3Controller.updateInputs(visProps);
        if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
            setShowNumBars(true);
        }
        setNumPlottedElements(d3Controller.getNumPlottedElements());
    }, [visProps.selectedInputs]);

    // update what events to be displayed (dram reads, dram writes, model numbers).
    useEffect(() => {
        if (!(d3Controller instanceof PerfDumpD3Controller) && !(d3Controller instanceof PerCoreD3Controller)) {
            return;
        }
        d3Controller.updateDisplayEvents(visProps);
        if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
            setShowNumBars(true);
        }
        setNumPlottedElements(d3Controller.getNumPlottedElements());
    }, [visProps.showAllDramReads, visProps.showAllDramWrites, visProps.showModelNumbers]);

    // useEffect(() => {
    //   if (!(d3Controller instanceof PerfDumpD3)) return;
    //   d3Controller.updatePlotDramReads(visProps);
    // }, [visProps.showAllDramReads])

    // update when dimensions (width, height, bar region height) changes.
    useEffect(() => {
        if (!d3Controller) {
            return;
        }
        d3Controller.resizeSVG(visProps);
    }, [visProps.height, visProps.width]);

    useEffect(() => {
        if (!d3Controller || d3Controller instanceof GraphD3Controller || graphMode) {
            return;
        }
        d3Controller.updateBarHeight(visProps);
    }, [visProps.barRegionHeight]);

    useEffect(() => {
        if (!d3Controller || d3Controller instanceof GraphD3Controller) {
            return;
        }
        d3Controller.updateXYOrder(visProps);
    }, [visProps.xyOrder]);

    useEffect(() => {
        if (!d3Controller || d3Controller instanceof GraphD3Controller) {
            return;
        }
        d3Controller.updateFrequency(visProps);
    }, [visProps.frequency]);

    // update ncrisc mode graph on ncrisc visprops changes (fields, cores)
    useEffect(() => {
        if (!ncriscMode) {
            return;
        }
        if (!shouldUpdate) {
            setShouldUpdate(true);
            return;
        }
        if (d3Controller instanceof NcriscD3Controller) {
            d3Controller.updateFields(ncriscVisProps);
            if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
                setShowNumBars(true);
            }
        }
        if (d3Controller) {
            setNumPlottedElements(d3Controller.getNumPlottedElements());
        }
    }, [ncriscVisProps.selectedFields]);

    useEffect(() => {
        if (!ncriscMode) {
            return;
        }
        if (!shouldUpdate) {
            setShouldUpdate(true);
            return;
        }
        if (d3Controller instanceof NcriscD3Controller) {
            d3Controller.updateCores(ncriscVisProps);
            if (d3Controller.getNumBars() >= BAR_THRESHOLD) {
                setShowNumBars(true);
            }
        }
        if (d3Controller) {
            setNumPlottedElements(d3Controller.getNumPlottedElements());
        }
    }, [ncriscVisProps.selectedCores]);

    useEffect(() => {
        if (d3Controller instanceof GraphD3Controller) {
            d3Controller.update(visProps);
        }
    }, [visProps.showModelNumbers]);

    useEffect(() => {
        if (!d3Controller || d3Controller instanceof GraphD3Controller || selectedLabel === '') {
            return;
        }
        d3Controller.highlight(selectedLabel);
        setSelectedLabel('');
    }, [selectedLabel]);

    useEffect(() => {
        if (firstSelect && isHostSelected && isDeviceSelected && deviceFrequencyMap) {
            setFirstSelect(false);
            setAlertFrequency(true);
        }
        if (isHostSelected && isDeviceSelected && deviceFrequencyMap) {
            const ret = getFrequencyText(deviceFrequencyMap, 'white', '#00FFFF');
            if (ret.length == 0) {
                return;
            }
            pushToConsole({ content: <p>&nbsp;</p> });
            ret.forEach((v: React.ReactElement) => {
                pushToConsole({ content: v });
            });
        }
    }, [isHostSelected, isDeviceSelected]);

    const getConsoleOutput = (command: string, response: string): React.ReactElement => {
        return (
            <p key={0}>
                Executed: {command}.<br /> Got: {response}
            </p>
        );
    };

    const perfCommandMap = {
        args: {
            visProps,
        },
        '^ratatouille$': {
            execute: (command: string): React.ReactElement => {
                imgRef.current!.style.display = 'block';
                const ret = getConsoleOutput(command, 'You have won the game of ratatouille. Congratulations.');
                return ret;
            },
            description: 'Display a cute ratatouille.',
        },
        '^show model numbers$': {
            execute: (command: string): React.ReactElement => {
                if (!perfCommandMap.args.visProps.showModelNumbers) {
                    setVisProps({
                        ...perfCommandMap.args.visProps,
                        showModelNumbers: true,
                    });
                    return getConsoleOutput(command, 'Success. Now showing model numbers.');
                }
                return getConsoleOutput(command, 'Already showing model numbers.');
            },
            description: 'Display model numbers if not already displayed.',
        },
        '^select (.*)$': {
            execute: (command: string): React.ReactElement => {
                const regex = /^select (.*)$/i;
                const label = command.match(regex)![1];
                if (label === '') {
                    return getConsoleOutput(command, 'Error. Empty label.');
                }
                setSelectedLabel(label);
                return getConsoleOutput(
                    command,
                    `Success. Highlighted names containing ${command.match(/^select (.*)$/i)![1]}.`,
                );
            },
            description: 'Highlight op that contains label entered.',
        },
        '^version$': {
            execute: (command: string) => {
                return getConsoleOutput(command, `route-a-gui version ${version}`);
            },
            description: 'Print the version of PerfUI.',
        },
    };

    const findCommandResult = (command: string) => {
        const matchingCommandRegex = Object.keys(perfCommandMap).find(
            (regex: string) => regex !== 'args' && new RegExp(regex, 'i').test(command),
        );
        return matchingCommandRegex ? perfCommandMap[matchingCommandRegex] : null;
    };

    useEffect(() => {
        perfCommandMap.args.visProps = visProps;
    }, [visProps]);

    const getVersion = async () => {
        const remote = await import('@electron/remote');
        setVersion(remote.app.getVersion());
    };

    // initial console output
    useEffect(() => {
        pushToConsole({ content: <p>&nbsp;</p> });
        getVersion();
    }, []);

    if (!perfDumpData || (!perfDumpData.siliconData && !perfDumpData.hostData)) {
        alert("Couldn't find any silicon data or host data. Please check that the test directory is valid.");
        handleClose();
        return <div />;
    }

    // // console handle input
    const handleKey = (e: any) => {
        imgRef.current!.style.display = 'none';
        if (e.key === 'ArrowUp' && consoleIndex > 0) {
            setCmdValue(consoleHistory[consoleIndex - 1]);
            setConsoleIndex(consoleIndex - 1);
        } else if (e.key === 'ArrowDown' && consoleIndex < consoleHistory.length - 1) {
            setCmdValue(consoleHistory[consoleIndex + 1]);
            setConsoleIndex(consoleIndex + 1);
        } else if (e.key === 'Enter' && cmdValue.length > 0) {
            const newConsoleHistory = [...consoleHistory, cmdValue];
            setConsoleHistory(newConsoleHistory);
            setConsoleIndex(newConsoleHistory.length);
            pushToConsole({ className: 'console-cmd', content: cmdValue });
            const cmdResult = findCommandResult(cmdValue);
            const ret = cmdResult
                ? cmdResult.execute(cmdValue)
                : getConsoleOutput(cmdValue, 'Error: command not found.');
            pushToConsole({ content: ret });
            setCmdValue('');
        }
    };

    // handle reset zoom button click
    const handleResetZoom = () => {
        if (d3Controller == null) {
            return;
        }

        d3Controller.resetZoom();
    };

    // handle reload button click
    const handleReload = async () => {
        console.log('Reloading...');
        setReloading(true);
        if (d3Controller != null) {
            d3Controller.close();
            d3Controller = null;
        }
        perfDumpData.clear();
        handleClose();
        await onReload(visProps);
    };

    return (
        <div className="pd-perf-dump" id="pd-perf-dump">
            {/* <LoadingAlert alertLoading={alertLoading} setAlertLoading={setAlertLoading} progress={progress} /> */}
            <div className="pd-perf-dump-controls">
                {reloading && 'Reloading...'}
                {!reloading && (
                    <Tooltip2 content="Select a Different Dump">
                        <Button
                            intent="primary"
                            icon="folder-open"
                            disabled={reloading}
                            onClick={() => {
                                if (d3Controller != null) {
                                    d3Controller.close();
                                    d3Controller = null;
                                }
                                perfDumpData.clear();
                                // d3ControllerDefault = null;
                                // d3ControllerNcrisc = null;
                                // d3ControllerPerCore = null;
                                handleClose();
                            }}
                        />
                    </Tooltip2>
                )}
                <Tooltip2 content="Reload Dump">
                    <Button intent="primary" icon="refresh" loading={reloading} onClick={handleReload} />
                </Tooltip2>
                {!reloading && (
                    <Tooltip2 content="Reset Zoom">
                        <Button intent="primary" icon="zoom-to-fit" disabled={reloading} onClick={handleResetZoom} />
                    </Tooltip2>
                )}
                {!reloading && (
                    <CapturePerfButton
                        loading={screenCaptureLoading}
                        disable={graphMode}
                        captureFunc={screenCaptureFunction}
                    />
                )}
                <ShowFolderTreeSwitch showTree={showFolderTree} setShowTree={setShowFolderTree} hide={reloading} />
                <ModelNumberSwitch
                    modelData={modelData}
                    visProps={visProps}
                    setVisProps={setVisProps}
                    hide={ncriscMode || reloading || !siliconData}
                />
                <XYOrderSwitch
                    modelData={modelData}
                    visProps={visProps}
                    setVisProps={setVisProps}
                    hide={graphMode || reloading || !siliconData}
                />
                {/* <FolderMenus visProps={visProps} setVisProps={setVisProps} hide={!folderMap || folderMap.allFolderPaths.length == 0 || ncriscMode || reloading} /> */}
                <div className="perf-multi-select-container">
                    <FrequencySelect
                        folderMap={folderMap}
                        visProps={visProps}
                        setVisProps={setVisProps}
                        hide={reloading || graphMode || !siliconData || !hostData || !deviceFrequencyMap}
                    />
                    <UnitSelect
                        isHostSelected={isHostSelected}
                        currentUnit={visProps.unit}
                        onUnitChange={(unit) => {
                            if (!d3Controller || d3Controller instanceof GraphD3Controller) {
                                return;
                            }
                            d3Controller.updateUnit(unit);
                            setVisProps({ ...visProps, unit });
                        }}
                        hide={reloading || graphMode || !siliconData || !hostData}
                    />
                    <InputMenu
                        inputOptions={visProps.selectableInputs}
                        selectedInputs={visProps.selectedInputs}
                        onSelectionChange={(selectedInputs) => setVisProps({ ...visProps, selectedInputs })}
                        numPlottedElements={d3Controller ? d3Controller.getNumPlottedElements() : 0}
                        maxPlottedElements={MAX_PLOTTED_ELEMENTS}
                        hide={ncriscMode || reloading || !siliconData}
                        graphMode={graphMode}
                        pushToConsole={pushToConsole}
                    />
                    <DisplayDramReadWrite
                        visProps={visProps}
                        setVisProps={setVisProps}
                        hide={ncriscMode || graphMode || reloading || !siliconData}
                    />
                    <NcriscCoreMenu
                        ncriscVisProps={ncriscVisProps}
                        setNcriscVisProps={setNcriscVisProps}
                        hide={!ncriscMode || reloading || !siliconData}
                    />
                    <NcriscFieldMenu
                        ncriscVisProps={ncriscVisProps}
                        setNcriscVisProps={setNcriscVisProps}
                        hide={!ncriscMode || reloading || !siliconData}
                    />
                </div>
                <Tooltip2 content="Toggle Bar Thickness">
                    <ToggleBarRegionHeight
                        visProps={visProps}
                        setVisProps={setVisProps}
                        hide={reloading || graphMode}
                    />
                </Tooltip2>
                <PerCoreModeSwitch
                    perCoreMode={perCoreMode}
                    setPerCoreMode={setPerCoreMode}
                    pushToOutput={pushToOutput}
                    hide={ncriscMode || graphMode || reloading || !siliconData}
                    resetStates={[setGraphMode, setNcriscMode]}
                />
                <NcriscModeSwitch
                    ncriscMode={ncriscMode}
                    setNcriscMode={setNcriscMode}
                    hide={perCoreMode || graphMode || reloading || !siliconData}
                    resetStates={[setGraphMode, setPerCoreMode]}
                />
                <GraphModeSwitch
                    graphMode={graphMode}
                    setGraphMode={setGraphMode}
                    hide={ncriscMode || perCoreMode || reloading || !siliconData}
                    disable
                />
                <Tag className="num-elements-indicator" minimal round>
                    <Icon style={{ marginRight: '0.5em' }} icon="comparison" />
                    {numPlottedElements} Plotted Elements
                </Tag>
            </div>
            <div className="perf-dump-folder-tree-and-console">
                <div className="left-column">
                    <div className="results-test-header">
                        <span>
                            <Icon icon="chart" intent="primary" className="results-test-icon" />
                            <Tooltip2 content={resultsName} placement="bottom" disabled={!perfResultsMeta}>
                                <span className="results-test-name">
                                    {resultsName.slice(0, 30) + (resultsName.length > 30 ? '...' : '')}
                                </span>
                            </Tooltip2>
                        </span>
                        <span className="results-reset-selection">
                            <Tooltip2 content="Reset Selection to Host" placement="right">
                                <Button
                                    intent="primary"
                                    icon="minus"
                                    small
                                    disabled={reloading || (isHostSelected && !isDeviceSelected)}
                                    onClick={(_e) =>
                                        folderTreeDispatch({
                                            type: 'RESET_SELECTION',
                                            context: visContext,
                                        })
                                    }
                                />
                            </Tooltip2>
                        </span>
                    </div>
                    <div className="folder-tree">
                        <FolderTree
                            key={perfResultsMeta?.path}
                            nodes={folderTree}
                            onTreeAction={(action: TreeAction) => {
                                folderTreeDispatch({ ...action, context: visContext });
                            }}
                            hide={reloading}
                        />
                    </div>
                </div>
                <div className="folder-tree-resizer" />
                <div className="perf-and-console">
                    <div className="pd-perf-dump-content" id="pd-perf-dump-content" ref={d3Ref} />
                    <div className="pd-console">
                        <PerfConsole
                            imgRef={imgRef}
                            tabId={tabId}
                            setTabId={setTabId}
                            consoleText={consoleText}
                            outputText={outputText}
                            cmdValue={cmdValue}
                            setCmdValue={setCmdValue}
                            handleKey={handleKey}
                            hide={graphMode}
                        />
                    </div>
                </div>
                <div className="perf-graph">
                    <div className="graph-perf-dump-content" ref={graphRef} />
                    <PerfGraph graphPlot={graphPlot!} graphMode={graphMode} />
                </div>
            </div>
            <FrequencyAlert
                alertFrequency={alertFrequency}
                setAlertFrequency={setAlertFrequency}
                deviceFrequencyMap={deviceFrequencyMap}
                visProps={visProps}
                setVisProps={setVisProps}
            />
        </div>
    );
};

export default PerfDumpWrapper;
