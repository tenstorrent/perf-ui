// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import React, { Dispatch, ReactElement, SetStateAction, useState } from 'react';

import { isEqual, last } from 'lodash';
import {
    Alert,
    Alignment,
    Button,
    FormGroup,
    Icon,
    MenuDivider,
    MenuItem,
    NumericInput,
    ProgressBar,
    Slider,
    Switch,
    Tree,
    TreeEventHandler,
    TreeNodeInfo,
} from '@blueprintjs/core';
import { ItemPredicate, ItemRenderer, MultiSelect, MultiSelect2 } from '@blueprintjs/select';
import { Tooltip2 } from '@blueprintjs/popover2';
import {
    FolderPathSequence,
    Frequency,
    PerfDumpVisProps,
    TreeAction,
    Unit,
    getFrequencyText,
    getOutputText,
    lastElement,
} from './perf_utils';
import PerfDumpFolderMap from './folder_map';
import { NcriscDumpVisProps } from './types';
import { ConsoleLine } from '../spatial_gui/console_text';

// const capitalize = s => s && s[0].toUpperCase() + s.slice(1);

const isChecked = (ev: React.FormEvent): boolean => {
    return (ev.target as HTMLInputElement).checked;
};

interface CapturePerfButtonProps {
    loading: boolean;
    disable: boolean;
    captureFunc: () => void;
}

export const CapturePerfButton = ({ loading, disable, captureFunc }: CapturePerfButtonProps): ReactElement => {
    return (
        <Tooltip2 content="Plot Capture" openOnTargetFocus={false}>
            <Button
                intent="primary"
                icon={<Icon icon="media" size={20} />}
                onClick={captureFunc}
                loading={loading}
                disabled={disable}
            />
        </Tooltip2>
    );
};

interface PerfDoubleSelectionProps {
    title1: string;
    description1: string;
    title2: string;
    description2: string;
    children1: React.ReactElement;
    children2: React.ReactElement;
}

export const PerfDoubleSelection: React.FC<PerfDoubleSelectionProps> = ({
    title1,
    description1,
    title2,
    description2,
    children1,
    children2,
}) => {
    return (
        <div className="perf-double-select">
            <div className="perf-first-selection-group">
                <div className="perf-selection-title" style={{ fontSize: 18 }}>
                    {title1}
                </div>
                <div className="perf-selection-description" style={{ width: 450 }}>
                    {description1}
                </div>
                {children1}
            </div>
            <div className="perf-second-selection-group">
                <br />
                <div className="perf-selection-title" style={{ fontSize: 18 }}>
                    {title2}
                </div>
                <div className="perf-selection-description" style={{ width: 450 }}>
                    {description2}
                </div>
                {children2}
            </div>
        </div>
    );
};

export const LoadingAlert = ({
    alertLoading,
    setAlertLoading,
    progress,
}: {
    alertLoading: boolean;
    setAlertLoading: (val: boolean) => void;
    progress: number;
}): React.ReactElement => {
    const text = ['Loading'];
    for (let i = 0; i < 50; i++) {
        text.push('\u00a0');
    }
    return (
        <Alert
            className="progress-alert"
            confirmButtonText="Cancel"
            icon="more"
            intent="primary"
            isOpen={alertLoading}
            onConfirm={() => setAlertLoading(false)}
        >
            <h3 style={{ color: 'black' }}>{text.join('')}</h3>
            <ProgressBar className="mode-switch-progress" intent="primary" stripes value={progress} />
        </Alert>
    );
};

interface FrequencyAlertProps {
    deviceFrequencyMap: Map<string, Record<number, Record<string, number>>> | null;
    alertFrequency: boolean;
    setAlertFrequency: Dispatch<SetStateAction<boolean>>;
    visProps: PerfDumpVisProps;
    setVisProps: Dispatch<SetStateAction<PerfDumpVisProps>>;
}

export const FrequencyAlert: React.FC<FrequencyAlertProps> = ({
    deviceFrequencyMap,
    alertFrequency,
    setAlertFrequency,
    visProps,
    setVisProps,
}) => {
    if (deviceFrequencyMap == null) {
        return <div />;
    }

    const getAlertText = (
        deviceFrequencyMap: Map<string, Record<number, Record<string, number>>>,
    ): React.ReactElement[] => {
        let text: Array<React.ReactElement> = [
            <p key="-1" style={{ color: 'black' }}>
                Sizeable discrepancy between AICLK and derived clock frequency.
            </p>,
        ];
        const dataText = getFrequencyText(deviceFrequencyMap);
        if (dataText.length == 0) {
            return [];
        }
        text = text.concat(dataText);
        text.push(
            <p key={(text.length + 1).toString()} style={{ color: 'black' }}>
                Would you like to proceed with the derived frequency or use AICLK instead?
            </p>,
        );
        return text;
    };

    const alertText = getAlertText(deviceFrequencyMap);

    return (
        <Alert
            className="frequency-alert"
            confirmButtonText="Proceed"
            cancelButtonText="Use AICLK"
            icon="high-priority"
            intent="primary"
            isOpen={alertFrequency && deviceFrequencyMap && deviceFrequencyMap.size > 0 && alertText.length > 0}
            onConfirm={() => {
                setVisProps({ ...visProps, frequency: Frequency.DERIVED });
                setAlertFrequency(false);
            }}
            onCancel={() => {
                setVisProps({ ...visProps, frequency: Frequency.AICLK });
                setAlertFrequency(false);
            }}
        >
            <h3 style={{ color: 'black' }}>Major Clock Frequency Difference</h3>
            <div>{alertText}</div>
        </Alert>
    );
};
// Functions and types for folder tree
// TODO: add double click folder

interface ShowFolderTreeSwitchProps {
    showTree: boolean;
    setShowTree: Dispatch<SetStateAction<boolean>>;
    hide: boolean;
}

export const ShowFolderTreeSwitch = ({
    showTree,
    setShowTree,
    hide,
}: ShowFolderTreeSwitchProps): React.ReactElement => {
    if (hide) {
        return <div />;
    }
    return (
        <Switch
            className="folder-tree-switch"
            label="Show Folder Tree"
            checked={showTree}
            alignIndicator={Alignment.RIGHT}
            onChange={(ev) => {
                setShowTree(isChecked(ev));
            }}
        />
    );
};

// const updateDoubleClickSelections = (nodes: TreeNodeInfo[], path: NodePath, visProps: PerfDumpVisProps, setVisProps: CallableFunction) => {
//   // console.log("NODES IN UPDATE NODE SELECTIONS:", nodes);
//   const node = Tree.nodeFromPath(path, nodes);
//   const newSelectedPaths = [];

//   const selectAllLeafNodes = (node: TreeNodeInfo) => {
//     if (!node.childNodes) {
//       node.isSelected = true;
//     }
//   };
// };

interface IFolderTree {
    nodes: TreeNodeInfo[];
    onTreeAction: Dispatch<TreeAction>;
    hide: boolean;
}

export const FolderTree: React.FC<IFolderTree> = ({ nodes, onTreeAction: dispatchTreeAction, hide }) => {
    const [lastSelectedNodePath, setLastSelectedNodePath] = useState<number[] | null>(null);

    if (hide) {
        return <div />;
    }

    const handleNodeClick: TreeEventHandler = (node, nodePath, e) => {
        if (node.childNodes) {
            // We only care about clicks on leaf nodes
            return;
        }
        const parentPath = nodePath.slice(0, -1);
        let shouldMultiSelect = false;
        if (e.shiftKey && lastSelectedNodePath !== null) {
            const lastSelectedParentPath = lastSelectedNodePath.slice(0, lastSelectedNodePath.length - 1);
            const isSameParent = isEqual(parentPath, lastSelectedParentPath);
            const isSameLeaf = nodePath.at(-1) === lastSelectedNodePath.at(-1);
            shouldMultiSelect = isSameParent && !isSameLeaf;
        }
        if (shouldMultiSelect && lastSelectedNodePath !== null) {
            const startIndex = lastSelectedNodePath.at(-1)!;
            const endIndex = nodePath.at(-1)!;
            dispatchTreeAction({
                payload: {
                    parentPath,
                    startIndex: Math.min(startIndex, endIndex),
                    endIndex: Math.max(startIndex, endIndex),
                },
                type: 'SELECT_RANGE',
            });
            // Keep the same last-selected-node-path
        } else if (node.isSelected) {
            dispatchTreeAction({
                payload: {
                    node,
                    path: nodePath,
                },
                type: 'SINGLE_DESELECT',
            });
            setLastSelectedNodePath(nodePath);
        } else {
            dispatchTreeAction({
                payload: {
                    node,
                    path: nodePath,
                },
                type: 'SINGLE_SELECT',
            });
            setLastSelectedNodePath(nodePath);
        }
    };

    return (
        <Tree
            className="bp4-folder-tree"
            contents={nodes}
            onNodeCollapse={(node, nodePath, _e) => {
                dispatchTreeAction({
                    payload: { node, path: nodePath, isExpanded: false },
                    type: 'SET_IS_EXPANDED',
                });
            }}
            onNodeExpand={(node, nodePath, _e) => {
                dispatchTreeAction({
                    payload: { node, path: nodePath, isExpanded: true },
                    type: 'SET_IS_EXPANDED',
                });
            }}
            onNodeClick={handleNodeClick}
        />
    );
};

/* tslint:disable:object-literal-sort-keys so childNodes can come last */
// Pick what trisc inputs to display
export const InputMenu = ({
    inputOptions,
    selectedInputs,
    onSelectionChange,
    numPlottedElements,
    maxPlottedElements,
    hide,
    graphMode,
    pushToConsole,
}: {
    inputOptions: string[];
    selectedInputs: string[];
    onSelectionChange: Dispatch<string[]>;
    numPlottedElements: number;
    maxPlottedElements: number;
    hide: boolean;
    graphMode: boolean;
    pushToConsole: Dispatch<ConsoleLine>;
}): React.ReactElement => {
    if (hide || inputOptions.length === 0) {
        return <div />;
    }
    const inputs = graphMode ? inputOptions : ['Show All Inputs', 'Reset Selection', 'divider'].concat(inputOptions);
    const renderItem: ItemRenderer<string> = (item, { modifiers, handleClick }) => {
        if (item === 'divider') {
            return <MenuDivider key="divider" />;
        }
        return (
            <MenuItem
                icon={<Icon icon={selectedInputs.includes(item) ? 'tick' : 'blank'} color="green" />}
                key={item}
                onClick={handleClick}
                text={item}
                shouldDismissPopover
            />
        );
    };

    const filterInput: ItemPredicate<string> = (query, input, _index, exactMatch) => {
        const normalizedInput = input.toLowerCase();
        const normalizedQuery = query.toLowerCase();
        if (exactMatch) {
            return normalizedQuery === normalizedInput;
        }
        return normalizedInput.indexOf(normalizedQuery) >= 0;
    };

    const logPlottedOpsWarning = (bulk = false) => {
        pushToConsole({ content: <p>&nbsp;</p> });
        pushToConsole({
            content: (
                <p className="console-error">
                    With the current selection, {bulk ? 'selecting all inputs' : 'adding another input'} will exceed the
                    maximum ({maxPlottedElements}) plotted elements.
                    <br />
                    {bulk
                        ? 'Try selecting individual inputs or reduce the number of epochs/events.'
                        : 'Reduce the number of plotted elements and try again.'}
                </p>
            ),
        });
    };

    const handleItemClick = (item: string) => {
        if (!selectedInputs.includes(item)) {
            // select
            const opsPerInput = Math.floor(numPlottedElements / (selectedInputs.length || 1));
            if (item === 'Show All Inputs') {
                if (inputOptions.length * opsPerInput >= maxPlottedElements) {
                    logPlottedOpsWarning(true);
                    return;
                }
                onSelectionChange(inputOptions);
                return;
            }
            if (item === 'Reset Selection') {
                onSelectionChange([inputOptions[0]]);
                return;
            }
            if (numPlottedElements + opsPerInput >= maxPlottedElements) {
                logPlottedOpsWarning();
                return;
            }
            const newArray = graphMode ? [] : [...selectedInputs];
            newArray.push(item);
            onSelectionChange(newArray);
        } else if (selectedInputs.includes(item)) {
            // deselect
            const newArray: string[] = [];
            for (const element of selectedInputs) {
                if (element !== item) {
                    newArray.push(element);
                }
            }
            if (newArray.length === 0 && graphMode) {
                return;
            }
            onSelectionChange(newArray);
        }
    };

    const handleRenderTag = (_item: string) => undefined;

    const handleClear = () => onSelectionChange([]);

    const clearButton =
        selectedInputs.length > 0 ? (
            <Button style={{ position: 'relative', top: 8 }} icon="cross" minimal onClick={handleClear} />
        ) : (
            <div style={{ width: 26 }} />
        );

    return (
        <FormGroup inline style={{ position: 'relative', top: -5 }}>
            <MultiSelect
                fill
                itemRenderer={renderItem}
                itemPredicate={filterInput}
                className="perf-multi-select"
                items={inputs}
                itemsEqual={(item1, item2) => item1 === item2}
                onItemSelect={handleItemClick}
                tagRenderer={handleRenderTag}
                selectedItems={selectedInputs}
                noResults={<MenuItem disabled text="No results." />}
                popoverProps={{
                    popoverClassName: 'input-multi-select',
                }}
                tagInputProps={{
                    rightElement: !graphMode ? clearButton : undefined,
                    placeholder: 'Input...',
                    intent: 'primary',
                }}
            />
        </FormGroup>
    );
};

interface VisModifierComponentProps {
    visProps: PerfDumpVisProps;
    setVisProps: Dispatch<SetStateAction<PerfDumpVisProps>>;
    hide: boolean;
}

type FrequencySelectProps = {
    folderMap: PerfDumpFolderMap;
} & VisModifierComponentProps;

export const FrequencySelect: React.FC<FrequencySelectProps> = ({ folderMap, visProps, setVisProps, hide }) => {
    if (hide || !folderMap.allFolderPaths.some((folderPath: string[]) => lastElement(folderPath) == 'host')) {
        return <div />;
    }
    const items = Object.values(Frequency);

    const renderItem = (item: Frequency, { modifiers, handleClick }) => {
        return (
            <MenuItem
                icon={<Icon icon={visProps.frequency == item ? 'tick' : 'blank'} color="green" />}
                key={items.indexOf(item)}
                onClick={handleClick}
                text={item}
                shouldDismissPopover
            />
        );
    };

    const filterFrequency: ItemPredicate<Frequency> = (query, frequency, _index, exactMatch) => {
        const normalizedDisplayEvent = frequency.toLowerCase();
        const normalizedQuery = query.toLowerCase();
        if (exactMatch) {
            return normalizedQuery === normalizedDisplayEvent;
        }
        return normalizedDisplayEvent.indexOf(normalizedQuery) >= 0;
    };

    const handleItemClick = (item: Frequency) => {
        if (item === visProps.frequency) {
            return;
        }
        setVisProps({ ...visProps, frequency: item });
    };

    const filler = <div style={{ width: 26 }} />;
    return (
        <FormGroup inline style={{ position: 'relative', top: -5 }}>
            <MultiSelect
                fill
                itemRenderer={renderItem}
                itemPredicate={filterFrequency}
                className="perf-multi-select"
                items={items}
                itemsEqual={(item1, item2) => item1 === item2}
                onItemSelect={handleItemClick}
                tagRenderer={(_) => undefined}
                selectedItems={[visProps.frequency as Frequency]}
                noResults={<MenuItem disabled text="No results." />}
                tagInputProps={{
                    rightElement: filler,
                    placeholder: 'Frequency...',
                    intent: 'primary',
                }}
            />
        </FormGroup>
    );
};

interface UnitSelectProps {
    isHostSelected: boolean;
    currentUnit: Unit;
    onUnitChange: Dispatch<Unit>;
    hide: boolean;
}

export const UnitSelect: React.FC<UnitSelectProps> = ({ isHostSelected, currentUnit, onUnitChange, hide }) => {
    if (hide) {
        return <div />;
    }

    const items = isHostSelected ? [Unit.NS] : Object.values(Unit);

    const renderItem: ItemRenderer<Unit> = (item: Unit, { modifiers, handleClick }) => {
        return (
            <MenuItem
                icon={<Icon icon={currentUnit === item ? 'tick' : 'blank'} color="green" />}
                key={items.indexOf(item)}
                onClick={handleClick}
                text={item}
                shouldDismissPopover
            />
        );
    };

    const filterUnits: ItemPredicate<string> = (query, unit, _index, exactMatch) => {
        const normalizedDisplayEvent = unit.toLowerCase();
        const normalizedQuery = query.toLowerCase();
        if (exactMatch) {
            return normalizedQuery === normalizedDisplayEvent;
        }
        return normalizedDisplayEvent.indexOf(normalizedQuery) >= 0;
    };

    const handleItemClick = (item: Unit) => {
        if (item === currentUnit) {
            return;
        }
        onUnitChange(item);
    };

    const handleRenderTag = (_: Unit) => undefined;

    const filler = <div style={{ width: 26 }} />;
    return (
        <FormGroup inline style={{ position: 'relative', top: -5 }}>
            <MultiSelect2
                fill
                itemRenderer={renderItem}
                itemPredicate={filterUnits}
                className="perf-multi-select"
                items={items}
                onItemSelect={handleItemClick}
                tagRenderer={handleRenderTag}
                selectedItems={[currentUnit]}
                noResults={<MenuItem disabled text="No results." />}
                tagInputProps={{
                    rightElement: filler,
                    placeholder: 'Unit...',
                    intent: 'primary',
                }}
            />
        </FormGroup>
    );
};

// Display dram-read/write in trisc mode
export const DisplayDramReadWrite: React.FC<VisModifierComponentProps> = ({ visProps, setVisProps, hide }) => {
    const options = ['Display all dram reads', 'Display all dram writes'];
    const [selectedItems, setSelectedItems] = useState<string[]>([]);

    const updateVisProps = () => {
        const showDramRead = selectedItems.includes('Display all dram reads');
        const showDramWrite = selectedItems.includes('Display all dram writes');
        setVisProps({
            ...visProps,
            showAllDramReads: showDramRead,
            showAllDramWrites: showDramWrite,
        });
    };

    const handleSelectionChange = (selection: string[]) => {
        setSelectedItems(selection);
        updateVisProps();
    };

    if (hide) {
        return <div />;
    }

    const renderItem = (item: string, { modifiers, handleClick }) => {
        return (
            <MenuItem
                icon={<Icon icon={selectedItems.includes(item) ? 'tick' : 'blank'} color="green" />}
                key={options.indexOf(item)}
                onClick={handleClick}
                text={item}
                shouldDismissPopover
            />
        );
    };

    const filterDisplay: ItemPredicate<string> = (query, displayEvent, _index, exactMatch) => {
        const normalizedDisplayEvent = displayEvent.toLowerCase();
        const normalizedQuery = query.toLowerCase();
        if (exactMatch) {
            return normalizedQuery === normalizedDisplayEvent;
        }
        return normalizedDisplayEvent.indexOf(normalizedQuery) >= 0;
    };

    const handleItemClick = (item: string) => {
        if (!selectedItems.includes(item)) {
            // select
            const newArray: string[] = [];
            for (const element of selectedItems) {
                newArray.push(element);
            }
            newArray.push(item);
            handleSelectionChange(newArray);
        } else if (selectedItems.includes(item)) {
            // deselect
            const newArray: string[] = [];
            for (const element of selectedItems) {
                if (element !== item) {
                    newArray.push(element);
                }
            }
            handleSelectionChange(newArray);
        }
    };

    const handleClear = () => handleSelectionChange([]);

    const clearButton =
        selectedItems.length > 0 ? (
            <Button style={{ position: 'relative', top: 8 }} icon="cross" minimal onClick={handleClear} />
        ) : (
            <div style={{ width: 26 }} />
        );

    return (
        <FormGroup inline style={{ position: 'relative', top: -5 }}>
            <MultiSelect
                fill
                itemRenderer={renderItem}
                itemPredicate={filterDisplay}
                className="perf-multi-select"
                items={options}
                itemsEqual={(item1, item2) => item1 === item2}
                onItemSelect={handleItemClick}
                tagRenderer={(_) => undefined}
                selectedItems={selectedItems}
                noResults={<MenuItem disabled text="No results." />}
                tagInputProps={{
                    rightElement: clearButton,
                    placeholder: 'Display...',
                    intent: 'primary',
                }}
            />
        </FormGroup>
    );
};

interface NcriscVisModifierComponentProps {
    ncriscVisProps: NcriscDumpVisProps;
    setNcriscVisProps: (visProps: NcriscDumpVisProps) => void;
    hide: boolean;
}

// Select what fields to show in ncriscMode
export const NcriscFieldMenu: React.FC<NcriscVisModifierComponentProps> = ({
    ncriscVisProps,
    setNcriscVisProps,
    hide,
}) => {
    if (hide) {
        return <div />;
    }

    const renderItem = (item: string, { modifiers, handleClick }) => {
        return (
            <MenuItem
                icon={<Icon icon={ncriscVisProps.selectedFields.includes(item) ? 'tick' : 'blank'} color="green" />}
                key={ncriscVisProps.allFields.indexOf(item)}
                onClick={handleClick}
                text={item}
                shouldDismissPopover
            />
        );
    };

    const filterFields = (query: string, field: string, _index?: number, exactMatch?: boolean) => {
        const normalizedQuery = query.toLowerCase();
        const normalizedField = field.toLowerCase();
        if (exactMatch) {
            return normalizedField === normalizedQuery;
        }
        return normalizedField.indexOf(normalizedQuery) >= 0;
    };

    const handleItemClick = (item: string) => {
        // don't allow deselecting epoch fields
        if (['Total Epoch', 'Epoch Prologue', 'Epoch Loop', 'Epoch Epilogue'].includes(item)) {
            return;
        }
        const newArray: string[] = [];
        // If item clicked is show all fields
        if (item === 'Show All Fields') {
            // Deselect show all fields
            if (ncriscVisProps.selectedFields.includes('Show All Fields')) {
                for (const field of ncriscVisProps.selectedFields) {
                    field != item && newArray.push(field);
                }
                setNcriscVisProps({ ...ncriscVisProps, selectedFields: newArray });
            }
            // Select show all fields
            else if (!ncriscVisProps.selectedFields.includes('Show All Fields')) {
                setNcriscVisProps({
                    ...ncriscVisProps,
                    selectedFields: ncriscVisProps.allFields,
                });
            }

            return;
        }
        // If item clicked is not show all fields
        if (!ncriscVisProps.selectedFields.includes(item)) {
            // select a field
            for (const field of ncriscVisProps.selectedFields) {
                newArray.push(field);
            }
            newArray.push(item);
        } else if (ncriscVisProps.selectedFields.includes(item)) {
            // deselect a field
            for (const field of ncriscVisProps.selectedFields) {
                field != item && newArray.push(field);
            }
        }
        setNcriscVisProps({ ...ncriscVisProps, selectedFields: newArray });
    };

    const handleClear = () => setNcriscVisProps({ ...ncriscVisProps, selectedFields: [] });

    const clearButton =
        ncriscVisProps.selectedFields.length > 0 ? (
            <Button style={{ position: 'relative', top: 8 }} icon="cross" minimal onClick={handleClear} />
        ) : (
            <div style={{ width: 26 }} />
        );

    return (
        <FormGroup inline style={{ position: 'relative', top: -5 }}>
            <MultiSelect
                fill
                itemRenderer={renderItem}
                itemPredicate={filterFields}
                className="perf-multi-select"
                items={ncriscVisProps.allFields}
                itemsEqual={(item1, item2) => item1 === item2}
                onItemSelect={handleItemClick}
                tagRenderer={(_) => undefined}
                selectedItems={ncriscVisProps.selectedFields}
                noResults={<MenuItem disabled text="No results." />}
                tagInputProps={{
                    rightElement: clearButton,
                    placeholder: 'Fields...',
                    intent: 'primary',
                }}
            />
        </FormGroup>
    );
};

// Select what cores to display in ncriscMode
export const NcriscCoreMenu: React.FC<NcriscVisModifierComponentProps> = ({
    ncriscVisProps,
    setNcriscVisProps,
    hide,
}) => {
    if (hide) {
        return <div />;
    }

    const renderItem = (item: string, { modifiers, handleClick }) => {
        return (
            <MenuItem
                icon={<Icon icon={ncriscVisProps.selectedCores.includes(item) ? 'tick' : 'blank'} color="green" />}
                key={ncriscVisProps.allCores.indexOf(item)}
                onClick={handleClick}
                text={item}
                shouldDismissPopover
            />
        );
    };

    const filterCores: ItemPredicate<string> = (query, core, _index, exactMatch) => {
        if (exactMatch) {
            return query === core;
        }
        return core.indexOf(query) >= 0;
    };

    const handleItemClick = (item: string) => {
        const newArray: string[] = [];
        if (item === 'Show All Cores') {
            // deselect show all cores
            if (ncriscVisProps.selectedCores.includes('Show All Cores')) {
                for (const core of ncriscVisProps.selectedCores) {
                    core != item && newArray.push(core);
                }
                setNcriscVisProps({ ...ncriscVisProps, selectedCores: newArray });
            }
            // select show all cores
            else if (!ncriscVisProps.selectedCores.includes('Show All Cores')) {
                setNcriscVisProps({
                    ...ncriscVisProps,
                    selectedCores: ncriscVisProps.allCores,
                });
            }
            return;
        }
        if (!ncriscVisProps.selectedCores.includes(item)) {
            // select a core
            for (const core of ncriscVisProps.selectedCores) {
                newArray.push(core);
            }
            newArray.push(item);
        } else if (ncriscVisProps.selectedCores.includes(item)) {
            // deselect a core
            for (const core of ncriscVisProps.selectedCores) {
                core != item && newArray.push(core);
            }
        }
        setNcriscVisProps({ ...ncriscVisProps, selectedCores: newArray });
    };

    const handleClear = () => setNcriscVisProps({ ...ncriscVisProps, selectedCores: [] });

    const clearButton =
        ncriscVisProps.selectedCores.length > 0 ? (
            <Button style={{ position: 'relative', top: 8 }} icon="cross" minimal onClick={handleClear} />
        ) : (
            <div style={{ width: 26 }} />
        );

    return (
        <FormGroup inline style={{ position: 'relative', top: -5 }} className="perf-multi-select">
            <MultiSelect
                fill
                itemRenderer={renderItem}
                itemPredicate={filterCores}
                items={ncriscVisProps.allCores}
                itemsEqual={(item1, item2) => item1 === item2}
                onItemSelect={handleItemClick}
                tagRenderer={(_) => undefined}
                selectedItems={ncriscVisProps.selectedCores}
                noResults={<MenuItem disabled text="No results." />}
                popoverProps={{
                    popoverClassName: 'core-multi-select',
                }}
                tagInputProps={{
                    rightElement: clearButton,
                    placeholder: 'Cores...',
                    intent: 'primary',
                    className: 'perf-multi-select',
                }}
            />
        </FormGroup>
    );
};

interface NcriscModeSwitchProps {
    ncriscMode: boolean;
    setNcriscMode: (ncriscMode: boolean) => void;
    hide: boolean;
    resetStates: Dispatch<SetStateAction<boolean>>[];
}

// Toggle ncrisc mode
export const NcriscModeSwitch = ({
    ncriscMode,
    setNcriscMode,
    hide,
    resetStates,
}: NcriscModeSwitchProps): React.ReactElement => {
    if (hide) {
        return <div />;
    }
    return (
        <Switch
            className="mode-switch"
            label="Ncrisc Mode"
            checked={ncriscMode}
            alignIndicator={Alignment.RIGHT}
            onChange={(ev) => {
                if (isChecked(ev)) {
                    resetStates.forEach((element) => {
                        element(false);
                    });
                }
                setNcriscMode(isChecked(ev));
            }}
        />
    );
};

interface IGraphMode {
    graphMode: boolean;
    setGraphMode: (graphMode: boolean) => void;
    hide: boolean;
    disable: boolean;
}
// Toggle ncrisc mode
export const GraphModeSwitch = ({ graphMode, setGraphMode, hide, disable }: IGraphMode): React.ReactElement => {
    if (hide) {
        return <div />;
    }
    return (
        <Tooltip2 position="right" content="Graph mode is disabled for now." disabled={!disable}>
            <Switch
                className="mode-switch"
                label="Graph Mode"
                checked={graphMode}
                disabled={disable}
                alignIndicator={Alignment.RIGHT}
                // disabled={hasGraphMode === false}
                onChange={(ev) => {
                    setGraphMode(isChecked(ev));
                }}
            />
        </Tooltip2>
    );
};

export const GraphModelRuntimeThreshold: React.FC<{
    graphRuntimeTh: number;
    setGraphRuntimeTh: (n: number) => void;
}> = ({ graphRuntimeTh, setGraphRuntimeTh }): React.ReactElement => {
    return (
        <NumericInput
            className="graph-mode-threshold"
            min={0.01}
            value={graphRuntimeTh}
            stepSize={5}
            placeholder="Runtime v Model threshold %"
            // defaultValue={20}
            style={{ width: 100, height: 30 }}
            // format={(num) => String(num) + '%'}
            onValueChange={(value, str) => {
                console.log('Changing Model-Silicon TH to ', value);
                setGraphRuntimeTh(value);
            }}
            onButtonClick={(value, str) => {
                console.log('Changing Model-Silicon TH to ', value);
                setGraphRuntimeTh(value);
            }}
        />
    );
};

type VisModifierWithModel = React.FC<
    {
        modelData: Map<string, Record<string, any>> | null;
    } & VisModifierComponentProps
>;

// Toggle show model numbers
export const ModelNumberSwitch: VisModifierWithModel = ({ modelData, visProps, setVisProps, hide }) => {
    if (hide) {
        return <div />;
    }
    return (
        <Switch
            className="model-numbers-switch"
            label="Show Model Numbers"
            checked={visProps.showModelNumbers}
            alignIndicator={Alignment.RIGHT}
            disabled={modelData == null}
            onChange={(ev) => {
                setVisProps((visProps) => {
                    return {
                        ...visProps,
                        showModelNumbers: isChecked(ev),
                    };
                });
            }}
        />
    );
};

export const XYOrderSwitch: VisModifierWithModel = ({ modelData, visProps, setVisProps, hide }) => {
    if (hide) {
        return <div />;
    }
    return (
        <Switch
            className="xy-order-switch"
            label="Switch X-Y Order"
            checked={visProps.xyOrder}
            alignIndicator={Alignment.RIGHT}
            disabled={modelData == null}
            innerLabel="x-y"
            innerLabelChecked="y-x"
            onChange={(ev) => {
                setVisProps((visProps) => {
                    return {
                        ...visProps,
                        xyOrder: isChecked(ev),
                    };
                });
            }}
        />
    );
};

interface PerCoreModeSwitchProps {
    perCoreMode: boolean;
    setPerCoreMode: Dispatch<SetStateAction<boolean>>;
    pushToOutput: Dispatch<ConsoleLine>;
    hide: boolean;
    resetStates: Dispatch<SetStateAction<boolean>>[];
}

// Toggle per core mode
export const PerCoreModeSwitch: React.FC<PerCoreModeSwitchProps> = ({
    perCoreMode,
    setPerCoreMode,
    pushToOutput,
    hide,
    resetStates,
}) => {
    if (hide) {
        return <div />;
    }
    return (
        <Switch
            className="mode-switch"
            label="Per Core Mode"
            checked={perCoreMode}
            alignIndicator={Alignment.RIGHT}
            onChange={(ev) => {
                if (isChecked(ev)) {
                    pushToOutput(getOutputText('Switched to per-core mode.'));
                    resetStates.forEach((element) => {
                        element(false);
                    });
                }
                // else if (!isChecked(ev)) {
                //   pushToOutput(getOutputText("Switched to default mode from per-core mode."));
                // }
                setPerCoreMode(isChecked(ev));
            }}
        />
    );
};

// Toggle plot bar region height
export const ToggleBarRegionHeight: React.FC<VisModifierComponentProps> = ({ visProps, setVisProps, hide }) => {
    if (hide) {
        return <div />;
    }
    return (
        <div className="bar-height-slider">
            <span className="toggle-text">Bar:</span>
            <Slider
                className="toggle-slider"
                initialValue={visProps.barRegionHeight}
                value={visProps.barRegionHeight}
                labelStepSize={290}
                max={300}
                min={10}
                onRelease={(newValue) =>
                    setVisProps({
                        ...visProps,
                        barRegionHeight: newValue,
                    })
                }
                onChange={(newValue) =>
                    setVisProps({
                        ...visProps,
                        barRegionHeight: newValue,
                    })
                }
            />
        </div>
    );
};
