// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

import React, { useCallback, useEffect, useState } from 'react';
import { Route, MemoryRouter as Router, Routes } from 'react-router-dom';
import './App.scss';
import { AnchorButton as A, Alert, HotkeysProvider, Icon } from '@blueprintjs/core';

import TenstorrentLogo from './tenstorrent_logo';
import { AppModeContext, SetErrorContext, WorkspaceContext } from './context';
import { PickWorkspace } from './welcome';
import PerfDumpWrapper from './perf_dump/perf_dump';
import {
    AppMode,
    IConfig,
    Workspace,
    loadConfig,
    storeConfig,
    verifyLocalWorkspace,
    workspaceCompare,
    workspaceToString,
} from './config';
import { testWorkspaceConnection } from './network';
import { ErrorModal } from './components/ErrorModal';

const TopNavChangeWorkspace: React.FC<{
    workspace: Workspace | null;
    appMode: AppMode;
    setAppMode: React.Dispatch<AppMode>;
}> = ({ workspace, appMode, setAppMode }) => {
    if (appMode === AppMode.PICK_WORKSPACE) {
        return <div />;
    }

    return (
        <div className="top-nav-workspace-path">
            {workspace && <span className="workspace-name">Workspace: {workspaceToString(workspace)}</span>}
            <A
                intent="primary"
                onClick={() => {
                    setAppMode(AppMode.PICK_WORKSPACE);
                }}
            >
                {workspace ? 'Change' : 'Select Workspace'}
            </A>
        </div>
    );
};

const TopNavMode: React.FC<{ workspace: Workspace | null; appMode: AppMode }> = ({ workspace, appMode }) => {
    if (appMode === AppMode.PERF_DUMP) {
        return (
            <div className="app-mode">
                <Icon icon="horizontal-bar-chart" size={30} />
                <span className="app-mode-text">Perf UI {workspace === null && '(Local Only Mode)'}</span>
            </div>
        );
    }
    return <div />;
};

const PerfUI = () => {
    // const svgRef = React.useRef(null);
    // const svgWidth = 200;
    // const svgHeight = 200;

    const [currentAppMode, setCurrentAppMode] = useState<AppMode>(AppMode.PICK_WORKSPACE);

    const [workspace, setWorkspace] = useState<Workspace | null>(null);

    // Error popup
    const [errorMsg, setErrorMsg] = useState('');
    const [showError, setShowError] = useState(false);

    const setError = useCallback(
        (errorMessage: string, log = true) => {
            if (log) {
                console.error('SETTING ERROR MESSAGE: ', errorMessage);
            }
            setErrorMsg(errorMessage);
            setShowError(true);
        },
        [setErrorMsg, setShowError],
    );

    // "Connecting" popup
    const [showConnecting, setShowConnecting] = useState(false);

    const [appConfig, setAppConfig] = useState<IConfig>({ workspaces: [] });

    useEffect(() => {
        loadConfig()
            .then(setAppConfig)
            .catch((err) => {
                throw err;
            });
    }, []);

    useEffect(() => {
        storeConfig(appConfig);
    }, [appConfig]);

    const applyNewWorkspace = async (w: Workspace, forceReconnect = true) => {
        if (forceReconnect) {
            setShowConnecting(true);
        }
        console.log('NEW WORKSPACE: ', w);
        try {
            if (w.remote) {
                await testWorkspaceConnection(w);
            } else if (!verifyLocalWorkspace(w)) {
                throw Error(`Local workspace does not exist at ${w.path}`);
            }
        } catch (err: any) {
            setErrorMsg(err.toString());
            setShowError(true);
            setShowConnecting(false);
        }
        setShowConnecting(false);
        setWorkspace(w);
    };

    const handleWorkspaceSelect = (selectedWorkspace: Workspace) => {
        console.log(`Selecting new workspace: ${workspaceToString(selectedWorkspace)}`);

        // move to the front of the config
        setAppConfig((appConfig) => ({
            ...appConfig,
            workspaces: [
                selectedWorkspace,
                ...appConfig.workspaces.filter((w) => !workspaceCompare(selectedWorkspace, w)),
            ],
        }));

        // if (workspace != undefined)
        //  closeConnection(workspace); // close connection to the old one, if there was one

        applyNewWorkspace(selectedWorkspace);
        setCurrentAppMode(AppMode.PERF_DUMP);
    };

    const handleNewWorkspace = (workspace: Workspace) => {
        console.log(`Adding new workspace: ${workspace.path}`);
        setAppConfig((appConfig) => ({
            ...appConfig,
            workspaces: [workspace, ...appConfig.workspaces],
        }));
        handleWorkspaceSelect(workspace);
    };

    const handleNoWorkspace = () => {
        console.log('Going to Perf Dump without a workspace');
        setWorkspace(null);
        setCurrentAppMode(AppMode.PERF_DUMP);
    };

    return (
        <HotkeysProvider dialogProps={{ className: 'bp4-dark' }}>
            <div className="App">
                <SetErrorContext.Provider value={setError}>
                    <WorkspaceContext.Provider value={workspace}>
                        <AppModeContext.Provider value={currentAppMode}>
                            <div className="TopNav">
                                {/* <img src={logo} /> */}
                                <TenstorrentLogo />
                                <TopNavMode workspace={workspace!} appMode={currentAppMode} />
                                <TopNavChangeWorkspace
                                    workspace={workspace!}
                                    appMode={currentAppMode}
                                    setAppMode={setCurrentAppMode}
                                />
                            </div>
                            <div className="MainLayout">
                                {currentAppMode === AppMode.PICK_WORKSPACE && (
                                    <PickWorkspace
                                        workspaces={appConfig.workspaces}
                                        handleNewWorkspace={handleNewWorkspace}
                                        handleWorkspaceSelect={handleWorkspaceSelect}
                                        handleNoWorkspace={handleNoWorkspace}
                                    />
                                )}
                                {currentAppMode === AppMode.PERF_DUMP && <PerfDumpWrapper />}
                            </div>
                        </AppModeContext.Provider>
                        {showError && (
                            <ErrorModal
                                errorMessage={errorMsg}
                                showError={showError}
                                setError={setErrorMsg}
                                setShowError={setShowError}
                            />
                        )}
                        <Alert className="bp4-dark" intent="none" isOpen={showConnecting} loading>
                            <div style={{ display: 'flex' }}>
                                {/* <Spinner size={40} /> */}
                                <p style={{ padding: '20px' }}>
                                    Connecting to {workspace && workspaceToString(workspace)}
                                </p>
                            </div>
                        </Alert>
                    </WorkspaceContext.Provider>
                </SetErrorContext.Provider>
            </div>
        </HotkeysProvider>
    );
};

export default function App(): React.ReactElement {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<PerfUI />} />
            </Routes>
        </Router>
    );
}
