// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

// Welcome component -- pick workspace, mode of operation, test/yaml

import React, { useState } from 'react';

import { Button, MenuItem } from '@blueprintjs/core';
import { ItemPredicate, ItemRenderer, Select } from '@blueprintjs/select';

import { Workspace, workspaceToString } from './config';
import AddWorkspaceButton from './add_workspace';
import { HelpText } from './help';

export const renderWorkspace: ItemRenderer<Workspace> = (workspace, { handleClick, modifiers, query }) => {
    if (!modifiers.matchesPredicate) {
        return null;
    }
    const text = workspaceToString(workspace);
    const label = workspace.remote ? `${workspace.sshHost}:${workspace.sshPort}` : 'local';
    return (
        <MenuItem
            active={modifiers.active}
            disabled={modifiers.disabled}
            label={label}
            key={text}
            onClick={handleClick}
            // text={highlightText(text, query)}
            text={workspace.path}
        />
    );
};

export const filterWorkspace: ItemPredicate<Workspace> = (query, workspace, _index, exactMatch) => {
    const normalizedTitle = workspace.path.toLowerCase();
    const normalizedQuery = query.toLowerCase();

    if (exactMatch) {
        return normalizedTitle === normalizedQuery;
    }
    return workspaceToString(workspace).indexOf(normalizedQuery) >= 0;
};

const WorkspaceSelect = Select.ofType<Workspace>();

const WorkspaceList = ({ workspaces, handleWorkspaceSelect }): React.ReactElement => {
    const [pickedWorkspace, setPickedWorkspace] = useState<Workspace>(workspaces[0]);

    return (
        <div>
            <WorkspaceSelect
                items={workspaces}
                itemPredicate={filterWorkspace}
                itemRenderer={renderWorkspace}
                filterable
                onItemSelect={(w) => {
                    setPickedWorkspace(w);
                }}
            >
                <Button
                    icon="data-lineage"
                    rightIcon="caret-down"
                    text={pickedWorkspace ? workspaceToString(pickedWorkspace) : '(No selection)'}
                    // disabled={restProps.disabled}
                />
            </WorkspaceSelect>
            <Button
                icon="document-open"
                text="Select"
                intent="primary"
                className="open-test-button"
                onClick={() => {
                    console.log('On click call with ', pickedWorkspace);
                    handleWorkspaceSelect(pickedWorkspace);
                }}
            />
        </div>
    );
};

export const PickWorkspace = ({
    workspaces,
    handleNewWorkspace,
    handleWorkspaceSelect,
    handleNoWorkspace,
}): React.ReactElement => {
    const haveSomeWorkspaces = workspaces.length > 0;

    return (
        <div className="select-model">
            <div className="welcome-content">
                <div className="welcome">Welcome to Tenstorrent Perf UI</div>
                {haveSomeWorkspaces && (
                    <>
                        <span className="select-model-text">
                            Please select a <HelpText helpKey="workspace" helpText="workspace" />:
                        </span>
                        <WorkspaceList workspaces={workspaces} handleWorkspaceSelect={handleWorkspaceSelect} />
                        <span className="select-model-text">Or:</span>
                    </>
                )}
                {!haveSomeWorkspaces && (
                    <span className="seelct-model-test">
                        No <HelpText helpKey="workspace" helpText="workspaces" /> have been used before. Please add a
                        new one.
                    </span>
                )}
                <AddWorkspaceButton onCreateWorkspace={handleNewWorkspace} />
                <Button
                    text="Use Perf UI Without Workspace (Local Only)"
                    intent="warning"
                    onClick={() => {
                        handleNoWorkspace();
                    }}
                />
            </div>
        </div>
    );
};
