// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

// Dialog where a user can add a local or remote workspace

import React, { useEffect, useState } from 'react';
import {
    Alert,
    Button,
    Dialog,
    FormGroup,
    Icon,
    IconName,
    InputGroup,
    MaybeElement,
    Spinner,
    SpinnerSize,
    Tab,
    Tabs,
} from '@blueprintjs/core';

import { verifyRemoteWorkspace } from './network';
import { Workspace, verifyLocalWorkspace } from './config';
import { SetErrorContext } from './context';
import { escapeWhitespace } from './common';

const MyInputGroup = ({ label, labelInfo, value, setValue }) => {
    return (
        <FormGroup
            // helperText="Helper text with details..."
            label={label}
            labelFor="text-input"
            // labelInfo="(typically $HOME/work/ll-sw)"
            labelInfo={labelInfo}
        >
            <InputGroup
                key="foo"
                value={value}
                onChange={(e) => {
                    setValue(e.target.value);
                }}
            />
        </FormGroup>
    );
};

const LocalWorkspace = ({ path, setPath }) => {
    return (
        <div className="add-workspace-panel">
            <MyInputGroup label="Path" labelInfo="(Typically $HOME/work/ll-sw)" value={path} setValue={setPath} />
        </div>
    );
};

const RemoteWorkspace = ({ path, setPath, host, setHost, port, setPort }) => {
    return (
        <div className="add-workspace-panel">
            <MyInputGroup label="Path" labelInfo="(Typically $HOME/work/ll-sw)" value={path} setValue={setPath} />
            <MyInputGroup label="SSH Host" labelInfo="" value={host} setValue={setHost} />
            <MyInputGroup label="SSH Port" labelInfo="" value={port} setValue={setPort} />
        </div>
    );
};

enum VerifSteps {
    CONNECT = 'connect',
    CHECK_PATH = 'check_path',
}
enum VerifStatus {
    IDLE,
    PROGRESS,
    FAILED,
    OK,
}

const VerifyItem = ({
    itemStatus,
    text,
    connectionError,
}: {
    itemStatus: VerifStatus;
    text: string;
    connectionError?: string;
}) => {
    const iconMap: Record<VerifStatus, { icon: IconName; color: string }> = {
        [VerifStatus.IDLE]: { icon: 'dot', color: 'grey' },
        [VerifStatus.PROGRESS]: { icon: 'dot', color: 'yellow' },
        [VerifStatus.FAILED]: { icon: 'cross', color: 'red' },
        [VerifStatus.OK]: { icon: 'tick', color: 'green' },
    };
    const icon = iconMap[itemStatus] || { icon: 'dot', color: 'blue' };

    return (
        <div className="verify-item" style={{ display: 'flex' }}>
            <Icon icon={icon.icon} color={icon.color} size={20} />
            <div className="verify-text">{text}</div>
            <div className="verify-error">{itemStatus == VerifStatus.FAILED && connectionError}</div>
        </div>
    );
};

interface AddWorkspaceProps {
    onCreateWorkspace(workspace: Workspace): void;
}

const AddWorkspaceButton = ({ onCreateWorkspace }: AddWorkspaceProps) => {
    const setAppError = React.useContext(SetErrorContext);
    const [isOpen, setIsOpen] = useState(false);
    const [verifStatus, setVerifStatus] = useState<Record<VerifSteps, VerifStatus>>({
        [VerifSteps.CONNECT]: VerifStatus.IDLE,
        [VerifSteps.CHECK_PATH]: VerifStatus.IDLE,
    });
    const [workspaceCandidate, setWorkspaceCandidate] = useState<Workspace>({
        remote: false,
        path: '',
        outputPath: '',
        sshHost: '',
        sshPort: '',
    });
    const [isValidWorkspace, setIsValidWorkspace] = useState(false);
    const [connectionError, setConnectionErrorLocal] = useState('');

    /** Sets both the global error and the local connection error value */
    const setConnectionError = (msg: string) => {
        console.error(`Connection error: ${msg}`);
        setAppError(msg);
        setConnectionErrorLocal(msg);
    };

    const clearVerifStatus = () => {
        setVerifStatus({
            [VerifSteps.CONNECT]: VerifStatus.IDLE,
            [VerifSteps.CHECK_PATH]: VerifStatus.IDLE,
        });
        setIsValidWorkspace(false);
    };

    const handleVerifyWorkspace = async () => {
        let current = VerifSteps.CONNECT;
        clearVerifStatus();
        setVerifStatus((verifStatus) => ({
            ...verifStatus,
            [VerifSteps.CONNECT]: VerifStatus.PROGRESS,
        }));
        try {
            await verifyRemoteWorkspace(
                workspaceCandidate,
                () => {
                    setVerifStatus((verifStatus) => ({
                        ...verifStatus,
                        [VerifSteps.CONNECT]: VerifStatus.OK,
                        [VerifSteps.CHECK_PATH]: VerifStatus.PROGRESS,
                    }));
                    current = VerifSteps.CHECK_PATH;
                },
                () => {
                    setVerifStatus((verifStatus) => ({
                        ...verifStatus,
                        [VerifSteps.CONNECT]: VerifStatus.OK,
                        [VerifSteps.CHECK_PATH]: VerifStatus.OK,
                    }));
                },
            );
            setIsValidWorkspace(true);
        } catch (err: any) {
            setVerifStatus((verifStatus) => ({
                ...verifStatus,
                [current]: VerifStatus.FAILED,
            }));
            setIsValidWorkspace(false);
            setConnectionError(err.toString());
        }
    };

    const handleAdd = () => {
        if (!workspaceCandidate.remote && !verifyLocalWorkspace(workspaceCandidate)) {
            const err = `No such file or directory: ${workspaceCandidate.path}`;
            setConnectionError(err);
            return;
        }
        setIsOpen(false);
        onCreateWorkspace(workspaceCandidate);
    };

    const selectedTabId = workspaceCandidate.remote ? 'lr_tabs_remote' : 'lr_tabs_local';

    const setPath = (path: string) => {
        setWorkspaceCandidate({
            ...workspaceCandidate,
            path,
            outputPath: `${escapeWhitespace(path.trim())}/tt_build`,
        });
        clearVerifStatus();
    };

    const setHost = (host: string) => {
        setWorkspaceCandidate({ ...workspaceCandidate, sshHost: host.trim() });
        clearVerifStatus();
    };

    const setPort = (port: string) => {
        console.log('workspace: ', workspaceCandidate);
        let modifiedPort: string = port;
        if (Number.isNaN(parseInt(port)) || parseInt(port).toString() !== port) {
            modifiedPort = '';
        }
        setWorkspaceCandidate({ ...workspaceCandidate, sshPort: modifiedPort.trim() });
        clearVerifStatus();
    };

    const changeTab = (tabId: string) => {
        setWorkspaceCandidate({
            ...workspaceCandidate,
            remote: tabId === 'lr_tabs_remote',
        });
        clearVerifStatus();
    };

    const isVerifying = Object.values(verifStatus).some((status) => status === VerifStatus.PROGRESS);

    return (
        <>
            <Button
                text="Add New Workspace"
                intent="primary"
                onClick={() => {
                    setIsValidWorkspace(false);
                    setIsOpen(true);
                }}
            />
            <Dialog
                className="dialog-add-workspace"
                isOpen={isOpen}
                title="Add New Workspace"
                canEscapeKeyClose={false}
                canOutsideClickClose={false}
                isCloseButtonShown={false}
            >
                <Tabs id="lr_tabs" selectedTabId={selectedTabId} onChange={changeTab}>
                    <Tab
                        id="lr_tabs_local"
                        title="Local"
                        panel={<LocalWorkspace path={workspaceCandidate.path} setPath={setPath} />}
                    />
                    <Tab
                        id="lr_tabs_remote"
                        title="Remote (SSH)"
                        panel={
                            <RemoteWorkspace
                                path={workspaceCandidate.path}
                                setPath={setPath}
                                host={workspaceCandidate.sshHost}
                                setHost={setHost}
                                port={workspaceCandidate.sshPort}
                                setPort={setPort}
                            />
                        }
                    />
                </Tabs>
                {workspaceCandidate.remote && (
                    <div className="verify-box">
                        <p>Verification status:</p>
                        <VerifyItem
                            itemStatus={verifStatus[VerifSteps.CONNECT]}
                            text="Connect"
                            connectionError={connectionError}
                        />
                        <VerifyItem
                            itemStatus={verifStatus[VerifSteps.CHECK_PATH]}
                            text="Check directory"
                            connectionError={connectionError}
                        />
                    </div>
                )}
                <div className="add-workspace-buttons">
                    <Button
                        text="Cancel"
                        intent="danger"
                        onClick={() => {
                            setIsOpen(false);
                        }}
                    />
                    {workspaceCandidate.remote && (
                        <Button
                            text="Verify"
                            intent="none"
                            onClick={() => {
                                handleVerifyWorkspace();
                            }}
                        />
                    )}
                    {isVerifying && <Spinner aria-label="Loading..." intent="primary" size={SpinnerSize.SMALL} />}
                    <Button
                        text="Add"
                        intent="success"
                        disabled={workspaceCandidate.remote && !isValidWorkspace}
                        onClick={() => {
                            handleAdd();
                        }}
                    />
                </div>
            </Dialog>
        </>
    );
};

export default AddWorkspaceButton;
