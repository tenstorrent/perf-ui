// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import fs from 'fs';
import path from 'path';
import React from 'react';
import { Button } from '@blueprintjs/core';
import type Electron from 'electron';
import PerfDumpData from './data_loader';
import { PerfDoubleSelection } from './components';

// setLoadingFromRemote and setLastLocalLoad can be null when we are calling this function to reload,
// if the function is called to set the data (not reload), then they should be callable
export const localFileSelect = async (filePath: string): Promise<PerfDumpData> => {
    // check if file is valid
    const dumpRegex = /^perf_postprocess.json$/;
    const dumpRegexSpatial1 = /^perf_postprocess_epoch_(\d+).json$/;
    if (!dumpRegex.test(path.basename(filePath)) && !dumpRegexSpatial1.test(path.basename(filePath))) {
        throw Error('Invalid selection. Must select either perf_postprocess.json or perf_postprocess_epoch_*.json');
    }
    console.log('Opening file: ', filePath);

    const rawdata = fs.readFileSync(path.resolve(filePath));
    // Parse the data into a javascript object
    const data = JSON.parse(rawdata.toString()); // TODO: add some error checking
    if (!data) {
        throw Error("Couldn't parse any JSON content in the selected file. Check that the file is valid.");
    }
    const dir = filePath.split('/').slice(-2)[0];
    return PerfDumpData.fromPerfPostprocessJson(dir, data);
};

interface ILocalDataLoader {
    onDataLoaded: (perfData: PerfDumpData, folderPath: string) => void;
    isLoading: boolean;
    setIsLoading: (v: boolean) => void;
}

export const LocalDataLoader = ({ onDataLoaded, isLoading, setIsLoading }: ILocalDataLoader): React.ReactElement => {
    const getPathFromDialog = async (source: 'file' | 'folder'): Promise<string | null> => {
        const remote = await import('@electron/remote');
        let dialogOptions: Electron.OpenDialogSyncOptions;
        if (source === 'file') {
            dialogOptions = {
                properties: ['openFile'],
                filters: [{ name: 'Perf Dump', extensions: ['json'] }],
            };
        } else {
            dialogOptions = {
                properties: ['openDirectory'],
            };
        }
        const openDialogResult = await remote.dialog.showOpenDialogSync(dialogOptions);

        // if nothing was selected, return
        if (!openDialogResult) {
            return null;
        }
        return String(openDialogResult);
    };

    const loadFile = async () => {
        const filePath = await getPathFromDialog('file');
        if (!filePath) {
            return;
        }

        setIsLoading(true);
        const perfDumpData = await localFileSelect(filePath);
        setIsLoading(false);
        onDataLoaded(perfDumpData, filePath);
    };

    const loadFolder = async () => {
        const folderPath = await getPathFromDialog('folder');
        if (!folderPath) {
            return;
        }

        setIsLoading(true);
        // Use a promise to yield control (and allow react to propagate state) before loading
        const perfDumpData = await new Promise<PerfDumpData>((resolve, _reject) => {
            resolve(PerfDumpData.fromFolder(folderPath));
        });
        setIsLoading(false);

        if (!perfDumpData.siliconData && !perfDumpData.hostData) {
            throw Error("Couldn't find any silicon data or host data. Please check that the directory is valid.");
        }
        onDataLoaded(perfDumpData, folderPath);
    };

    return (
        <PerfDoubleSelection
            title1="Single file"
            description1="Load a single perf_postprocess.json file."
            children1={
                <Button
                    icon="document-open"
                    text="Open File"
                    onClick={loadFile}
                    intent="primary"
                    disabled={isLoading}
                />
            }
            title2="Multi-graph folder"
            description2="Choose a directory with perf_postprocess.json and runtime_table.json files."
            children2={
                <Button
                    icon="folder-open"
                    text="Open Folder"
                    onClick={loadFolder}
                    intent="primary"
                    disabled={isLoading}
                />
            }
        />
    );
};
