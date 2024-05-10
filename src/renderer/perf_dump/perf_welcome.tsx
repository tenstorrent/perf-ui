// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Icon, MenuItem } from '@blueprintjs/core';
import { ItemRenderer, Select } from '@blueprintjs/select';

import PerfDumpData from './data_loader';
import { findWorkspacePerfDumpDirectories } from '../network';
import { LocalDataLoader } from './perf_local_select';
import { IPerfResults, filterPerfResults } from './perf_utils';
import { SetErrorContext, WorkspaceContext } from '../context';

const renderPerfResultMenuItem: ItemRenderer<IPerfResults> = (perfResult, { handleClick, modifiers, query }) => {
    if (!modifiers.matchesPredicate) {
        return null;
    }
    // const text = `${test.name}. ${test.path}`;
    const text = `${perfResult.path}`;
    const label = perfResult.testname;
    return (
        <MenuItem
            active={modifiers.active}
            disabled={modifiers.disabled}
            labelElement={label}
            key={perfResult.path}
            onClick={handleClick}
            text={text}
        />
    );
};

function PerfSelectionBox({ children, icon, title, description, hideIcon = false }): React.ReactElement {
    return (
        <div className="select-perf-box">
            {!hideIcon && <Icon icon={icon} size={150} className="select-perf-icon" />}
            <div className="select-perf-content">
                <h2>{title}</h2>
                <div className="select-perf-description">{description}</div>
                <div className="select-perf-selector">{children}</div>
            </div>
        </div>
    );
}

/** Select component (with type) */
const PerfResultsSelect = Select.ofType<IPerfResults>();

interface IPerfWelcome {
    handleLocalDataLoaded: (perfData: PerfDumpData, selectedPath: string) => void;
    handleSelectWorkspacePerfDumpTest: (selectedPerfDump: IPerfResults) => Promise<void>;
    isLoadingPerfData: boolean;
    setIsLoadingPerfData: (v: boolean) => void;
}

export default function PerfWelcome({
    handleLocalDataLoaded,
    handleSelectWorkspacePerfDumpTest,
    isLoadingPerfData,
    setIsLoadingPerfData,
}: IPerfWelcome): React.ReactElement {
    const workspace = React.useContext(WorkspaceContext);
    const setError = React.useContext(SetErrorContext);
    // state variables for remote select perf results
    const [workspacePerfResultsOptions, setWorkspacePerfResultsOptions] = useState<Array<IPerfResults>>([]);
    const [selectedPerfResultsFolder, setSelectedPerfResultsFolder] = useState<IPerfResults | null>(null);
    const [isLoadingPerfOptions, setIsLoadingPerfOptions] = useState<boolean>(false);

    const loadWorkspaceTestDirectories = useCallback(async (): Promise<void> => {
        if (!workspace) {
            return;
        }
        setIsLoadingPerfOptions(true);
        setSelectedPerfResultsFolder(null);
        let perfResults: IPerfResults[];
        try {
            perfResults = await findWorkspacePerfDumpDirectories(workspace);
        } catch (e: any) {
            setWorkspacePerfResultsOptions([]);
            setIsLoadingPerfOptions(false);
            const msg = 'Failed to retrieve list of perf results.';
            console.error(`${msg}\n\n`, e);
            setError([msg, e.toString()].join('\n'));
            return;
        }
        setWorkspacePerfResultsOptions(perfResults);
        if (perfResults.length > 0) {
            setSelectedPerfResultsFolder(perfResults[0]);
        }
        setIsLoadingPerfOptions(false);
    }, [workspace, setError]);

    useEffect(() => {
        if (!workspace) {
            return;
        }
        loadWorkspaceTestDirectories();
    }, [workspace, loadWorkspaceTestDirectories]);

    const PerfSelectionFromWorkspace = (
        <PerfSelectionBox
            icon="cloud-download"
            title="Remote Selection"
            description="Pick a perf_results folder containing perf dump outputs to be plotted."
        >
            <div className="select-perf-text">Choose a test to plot: </div>
            <PerfResultsSelect
                className="perf-results-remote-select"
                items={workspacePerfResultsOptions}
                itemPredicate={filterPerfResults}
                itemRenderer={renderPerfResultMenuItem}
                filterable
                resetOnQuery={false}
                disabled={isLoadingPerfOptions || isLoadingPerfData}
                onItemSelect={setSelectedPerfResultsFolder}
            >
                <Button
                    alignText="center"
                    icon="import"
                    rightIcon="caret-down"
                    text={selectedPerfResultsFolder ? selectedPerfResultsFolder.testname : '(No selection)'}
                    loading={isLoadingPerfOptions}
                    disabled={isLoadingPerfData}
                />
            </PerfResultsSelect>
            <Button
                icon="new-drawing"
                text="Plot"
                intent="primary"
                className="apply-perf-results-folder-button"
                loading={isLoadingPerfOptions || isLoadingPerfData}
                disabled={
                    isLoadingPerfOptions ||
                    !selectedPerfResultsFolder ||
                    !workspacePerfResultsOptions ||
                    workspacePerfResultsOptions.length === 0
                }
                onClick={() => {
                    handleSelectWorkspacePerfDumpTest(selectedPerfResultsFolder!);
                }}
            />
            <Button
                icon="repeat"
                text="Refresh"
                intent="primary"
                className="refresh-perf-results-button"
                disabled={isLoadingPerfOptions || isLoadingPerfData}
                onClick={loadWorkspaceTestDirectories}
            />
        </PerfSelectionBox>
    );

    const PerfSelectionFromLocal = (
        <PerfSelectionBox icon="folder-open" title="Local Selection" description="">
            <LocalDataLoader
                onDataLoaded={handleLocalDataLoaded}
                isLoading={isLoadingPerfData}
                setIsLoading={setIsLoadingPerfData}
            />
        </PerfSelectionBox>
    );

    return (
        <div className="select-perf">
            <div className="perf-welcome-content">
                <div className="perf-welcome">Tenstorrent Silicon Performance Analyzer</div>
                <div className="select-perf-container">
                    {workspace && PerfSelectionFromWorkspace}
                    {PerfSelectionFromLocal}
                </div>
            </div>
        </div>
    );
}
