// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import fs from 'fs';
import path from 'path';

import { Icon, IconName, TreeNodeInfo } from '@blueprintjs/core';
import { Tooltip2 } from '@blueprintjs/popover2';
import { findSubDirectories } from 'renderer/common';
import { FolderPathSequence, MultiRootedRecordTree, PerfDumpModes, getJsonData, isHostDirectory } from './perf_utils';

export default class PerfDumpFolderMap {
    // folder map contains all the folders and its subfolders in a javascript object
    folderPathTree: MultiRootedRecordTree;

    // 2d array that contains all possible folder combinations, each nested array contains a valid combination of folders
    allFolderPaths: FolderPathSequence[];

    treeNodes: TreeNodeInfo[];

    mode: PerfDumpModes;

    constructor(folderPathTree: MultiRootedRecordTree, allFolderPaths?: FolderPathSequence[]) {
        this.folderPathTree = folderPathTree;
        this.allFolderPaths = Array.isArray(allFolderPaths) ? allFolderPaths : this.generateAllFolderPaths();
        // if (this.inDefaultMode()) this.mode = PerfDumpModes.DEFAULT;
        if (this.inTrainingMode()) {
            this.mode = PerfDumpModes.TRAINING;
        } else {
            this.mode = PerfDumpModes.CUSTOM;
        }
        this.treeNodes = treeNodesFromFolderTree(this.folderPathTree, []) || [];
        if (this.treeNodes.length === 0) {
            console.warn('No Tree Nodes were constructed from folder tree; folder paths may be invalid');
        }
    }

    /** Generates an array of all folder paths from the instance's folder path tree */
    generateAllFolderPaths(): FolderPathSequence[] {
        if (Object.keys(this.folderPathTree).length === 0) {
            return [];
        }
        /** DFS traversal of folder tree that yields the path to each node */
        const generateFolderPathsHelper = function* (
            folderPaths: FolderPathSequence,
            subFolderMap: MultiRootedRecordTree,
        ): Generator<FolderPathSequence> {
            if (Object.keys(subFolderMap).length === 0) {
                yield [...folderPaths];
            }
            for (const folder of Object.keys(subFolderMap)) {
                folderPaths.push(folder);
                yield* generateFolderPathsHelper(folderPaths, subFolderMap[folder]);
                folderPaths.pop();
            }
        };
        return [...generateFolderPathsHelper([], this.folderPathTree)];
    }

    /** Builds a BlueprintJS Tree from the instance's folder path tree */
    buildComponentTreeFromFolderTree(): TreeNodeInfo[] {
        if (Object.keys(this.folderPathTree).length === 0) {
            return [];
        }
        const allTreeNodes = treeNodesFromFolderTree(this.folderPathTree, []);

        if (!allTreeNodes) {
            throw new Error('No Tree Nodes were constructed from folder tree; folder paths may be invalid');
        }
        return allTreeNodes;
    }

    // check if we are in default mode, if we are, the drop down menus will be labeled specifically
    // inDefaultMode(): boolean {
    //   return this.allFolderPaths.every((folderPath: string[]) => folderPath.length == 2);
    // }

    // check if we are in training mode, if we are, the drop down menus will be labeled specifically
    inTrainingMode(): boolean {
        const batchRegex = /^batch_(\d+)$/;
        const minibatchRegex = /^minibatch_(\d+)$/;
        const microbatchRegex = /^microbatch_(\d+)$/;

        return this.allFolderPaths.every((folderPath: string[]) => {
            if (!['Forward', 'Backward', 'Optimizer'].includes(folderPath[0])) {
                return false;
            }
            if (folderPath[0] !== 'Optimizer') {
                if (folderPath.length !== 5) {
                    return false;
                }
                if (
                    !batchRegex.test(folderPath[1]) ||
                    !minibatchRegex.test(folderPath[2]) ||
                    !microbatchRegex.test(folderPath[3])
                ) {
                    return false;
                }
            } else if (folderPath[0] === 'Optimizer') {
                if (folderPath.length !== 3) {
                    return false;
                }
                if (!batchRegex.test(folderPath[1])) {
                    return false;
                }
            }
            return true;
        });
    }

    // get all the possible selections of the drop down menus based on the selected folder values
    // the returned 2d array contains selections for each folder
    getAllSelections(folderPath: string[]): string[][] {
        if (!this.isValidFolderPath(folderPath)) {
            console.error("INVALID KEY COMBO IN GET ALL SELECTIONS, SHOULDN'T HAPPEN!!");
        }
        const selections = [Object.keys(this.folderPathTree)];
        let folderMap = this.folderPathTree;
        for (const folder of folderPath) {
            if (folderMap[folder] && Object.keys(folderMap[folder]).length > 0) {
                selections.push(Object.keys(folderMap[folder]));
            }
            folderMap = folderMap[folder];
        }
        return selections;
    }

    // get a close matching key combo of the provided key combo, to minimize number of resetted drop down menus.
    // TODO: right now if a folder value is invalid, it is set to the first possible folder value, a better way may be to
    // search through all valid values for that invalid folder, and pick the one that matches the most later folder values to make the result a closer match
    getClosestFolderPath(folderPath: string[]): string[] {
        if (this.isValidFolderPath(folderPath)) {
            return folderPath;
        }
        const closestFolderPath: string[] = [];
        let folderMap = this.folderPathTree;
        for (const folder of folderPath) {
            if (folderMap[folder]) {
                closestFolderPath.push(folder);
                folderMap = folderMap[folder];
            } else if (!folderMap[folder]) {
                const possibleSubFolders = Object.keys(folderMap);
                if (possibleSubFolders.length === 0) {
                    return closestFolderPath;
                }
                const newValidFolder = possibleSubFolders[0];
                closestFolderPath.push(newValidFolder);
                folderMap = folderMap[newValidFolder];
            }
        }
        // if we have more subfolders, add the first ones to key combo
        // this could happen when we switch from a shorter folder combo to a longer one
        // for example when we switch from optimizer to backward
        while (Object.keys(folderMap).length > 0) {
            const newValidFolder = Object.keys(folderMap)[0];
            closestFolderPath.push(newValidFolder);
            folderMap = folderMap[newValidFolder];
        }
        return closestFolderPath;
    }

    // check if the key combination is valid
    isValidFolderPath(folderPath: string[]): boolean {
        let folderMap = this.folderPathTree;
        for (const folder of folderPath) {
            if (!folderMap[folder]) {
                return false;
            }
            folderMap = folderMap[folder];
        }
        return true;
    }

    // join the folderPath to get a string that should match a key of silicon/model/cores_to_ops data
    getDataKey(folderPath: string[]): string {
        return folderPath.join('/');
    }

    // TODO: add some error checking
    getBaseFolder(folderPath: string): string {
        return folderPath.split('/').pop()!;
    }

    static fromFolder(folderPath: string): PerfDumpFolderMap {
        // TODO: this is an interim solution, we shoudlnt be parsing folders as strings
        const separator = path.sep;
        const siliconRegex = /^perf_postprocess.json$/;
        const siliconRegexSpatial1 = /^perf_postprocess_epoch_(\d+).json$/;
        const hostRegex = /^(.*)proc_(\d+).json$/;

        /** Map the subfolders of a given root directory into a tree data structure containing relative paths from a root path.
         * Also save the found paths in an array.
         *
         * @param folderPath the path of the root directory
         * @param rootFolderPath the path of the root directory (from which relative paths will start)
         * @param allFolderPaths array for storing each found (valid) path.
         */
        const mapFolderTree = (
            folderPath: string,
            rootFolderPath: string,
            allFolderPaths: FolderPathSequence[], // Side effect: push each found path into this array
        ): MultiRootedRecordTree | null => {
            const subDirectories = findSubDirectories(folderPath);
            // check if this directory is a leaf node
            if (subDirectories.length === 0) {
                const dirEntryNames: string[] = fs.readdirSync(folderPath);
                const isHost =
                    path.basename(folderPath) === 'host' &&
                    dirEntryNames.some((filePath: string) => hostRegex.test(filePath));
                const siliconPath = dirEntryNames.filter(
                    (filePath: string) => siliconRegex.test(filePath) || siliconRegexSpatial1.test(filePath),
                );
                const isSilicon =
                    siliconPath.length === 1 &&
                    Object.keys(getJsonData(path.join(folderPath, siliconPath[0]))).length > 0;
                if (isHost || isSilicon) {
                    // Valid leaf node
                    return {};
                }
                // Invalid node
                return null;
            }
            const folderMap = Object.fromEntries(
                subDirectories
                    .map((subDirectoryPath: string) => {
                        allFolderPaths.push(path.relative(rootFolderPath, subDirectoryPath).split(separator));
                        return [
                            path.basename(subDirectoryPath),
                            mapFolderTree(subDirectoryPath, rootFolderPath, allFolderPaths),
                        ];
                    })
                    .filter(([_, value]) => value !== null),
            );
            if (Object.keys(folderMap).length === 0) {
                // Invalid node
                return null;
            }
            return folderMap;
        };

        // if user selected a single folder that directly contains data files, set mode to single dir
        if (findSubDirectories(folderPath).length === 0) {
            const folderTree = {
                [path.basename(folderPath)]: {},
            };
            const perfDumpFolderMap = new PerfDumpFolderMap(folderTree);
            perfDumpFolderMap.mode = isHostDirectory(folderPath)
                ? PerfDumpModes.SINGLE_HOST_DIR
                : PerfDumpModes.SINGLE_DIR;
            return perfDumpFolderMap;
        }
        const allFolderPaths: FolderPathSequence[] = [];
        const folderTree = mapFolderTree(folderPath, folderPath, allFolderPaths);
        if (folderTree == null) {
            throw new Error(`Invalid folder path: ${folderPath}`);
        }
        return new PerfDumpFolderMap(folderTree, allFolderPaths);
    }
}

const treeNodeFromFolder = (folderName: string, isLeafNode: boolean, pathFromRoot: string[]): TreeNodeInfo => {
    const icon: IconName = isLeafNode ? 'highlight' : 'folder-close';
    let toolTipText2;
    if (isLeafNode) {
        toolTipText2 = (
            <div>
                <span className="folder-tree-click-text">Click </span>to plot.
            </div>
        );
    }
    const toolTipContent = (
        <div>
            <p className="folder-tree-tooltip-name">{folderName}</p>
            <p className="folder-tree-tooltip-help">{toolTipText2}</p>
        </div>
    );
    const key = `${pathFromRoot.join('/')}/${folderName}`;
    return {
        id: key,
        className: folderName,
        icon: <Icon icon={icon} intent="primary" className="folder-tree-icon" />,
        isExpanded: false,
        isSelected: isLeafNode ? false : undefined,
        label: (
            <Tooltip2 openOnTargetFocus={false} content={toolTipContent} placement="right" intent="primary">
                {folderName}
            </Tooltip2>
        ),
    };
};

const treeNodesFromFolderTree = (
    folders: MultiRootedRecordTree,
    pathFromRoot: string[],
): TreeNodeInfo[] | undefined => {
    if (!folders || Object.keys(folders).length === 0) {
        return undefined;
    }
    return Object.entries(folders).map(
        ([folderName, subfolders]): TreeNodeInfo => ({
            ...treeNodeFromFolder(String(folderName), Object.keys(subfolders).length === 0, pathFromRoot),
            childNodes: treeNodesFromFolderTree(subfolders, [...pathFromRoot, folderName]),
        }),
    );
};
