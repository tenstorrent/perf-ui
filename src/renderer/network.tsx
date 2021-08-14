// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import dns from 'dns';

import fs from 'fs';
import fsPromises from 'fs/promises';

import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import { IPerfResults, perfResultsFromFolderPath } from './perf_dump/perf_utils';
import { escapeWhitespace, getWorkspaceId, runShellCommand, sshWrapCmd } from './common';
import { Workspace } from './config';

// Required for connecting to a socket on localhost
dns.setDefaultResultOrder('ipv4first');

/** setStarted/setConnected/setVerified are callbacks for GUI to show progress
 *
 * return value is a string with msg on why the verification failed, or empty string
 * if everything passed */
export const verifyRemoteWorkspace = async (
    w: Workspace,
    setConnected: () => void,
    setVerified: () => void,
): Promise<void> => {
    await testWorkspaceConnection(w);
    setConnected();
    await verifyWorkspacePath(w);
    setVerified();
};

export const testWorkspaceConnection = async (w: Workspace): Promise<void> => {
    try {
        await promisify(exec)(`ssh ${w.sshHost} -p ${w.sshPort} bash -c 'echo "connected"'`, { timeout: 8000 });
    } catch (e: any) {
        throw Error(`Failed to connect to workspace: ${e.toString()}`, {
            cause: e,
        });
    }
};

const verifyWorkspacePath = async (w: Workspace): Promise<void> => {
    try {
        await runShellCommand('ssh', sshWrapCmd(w, `ls ${w.path}`));
    } catch (e: any) {
        throw Error(`Failed to verify workspace path: ${e.toString()}`, {
            cause: e,
        });
    }
};

/** Fetches a list of directories in the given workspace which contain `perf_results` subdirectories */
export async function findWorkspacePerfDumpDirectories(workspace: Workspace): Promise<IPerfResults[]> {
    const parseResults = (results: string): IPerfResults[] =>
        results
            .split('\n')
            .filter((s) => s.length > 0)
            .map((directory) => perfResultsFromFolderPath(directory));
    console.log('Finding remote perf dump directories');
    const findParams = [
        '-L',
        workspace.outputPath,
        '-mindepth',
        '1',
        '-maxdepth',
        '3',
        '-type',
        'd',
        '-name',
        'perf_results',
    ];
    let stdout: Buffer | null;
    if (workspace.remote) {
        if (!workspace.sshHost || !workspace.sshPort) {
            throw Error('Workspace does not have ssh host/port set');
        }
        [stdout] = await runShellCommand('ssh', sshWrapCmd(workspace, `find ${findParams.join(' ')}`));
    } else {
        [stdout] = await runShellCommand('find', findParams);
    }
    return stdout ? parseResults(stdout.toString()) : [];
}

/** Syncs the remote directory containing a perf dump.
 *
 * Deletes the local copy of the previously loaded perf dump if it is different from the new directory.
 *
 * Implemented with rsync, only works on MacOS/Linux. Can only be called from Renderer process. */
export async function syncRemotePerfDump(workspace: Workspace, perfResults: IPerfResults): Promise<string> {
    const remote = await import('@electron/remote');
    if (!workspace) {
        throw Error('Workspace not set');
    }

    if (!workspace.remote) {
        throw Error('Workspace is not remote');
    }

    const testId = `${getWorkspaceId(workspace)}-${perfResults.testname.replace(/\s/g, '_')}`;
    console.log('SYNC REMOTE PERF DUMP', testId);

    const configDir = remote.app.getPath('userData');
    const localCopyPath = path.join(configDir, 'perfdatatmp/');
    if (!fs.existsSync(localCopyPath)) {
        await fsPromises.mkdir(localCopyPath);
    }

    const dirContents = await fsPromises.readdir(localCopyPath);
    if (dirContents.length && !dirContents.includes(testId)) {
        // Purge the remote copy directory
        await Promise.all(
            dirContents.map(async (file) =>
                fsPromises.rm(path.join(localCopyPath, file), {
                    recursive: true,
                    force: true,
                }),
            ),
        );
    }

    const destinationPath = path.join(localCopyPath, testId);
    console.log('PATH BEFORE:', perfResults.path);
    const sourcePath = perfResults.path;
    console.log('PATH AFTER:', sourcePath);
    const baseOptions = [
        '-s',
        '-az',
        '-e',
        `'ssh -p ${workspace.sshPort}'`,
        '--delete',
        `${workspace.sshHost}:${escapeWhitespace(sourcePath)}`,
        escapeWhitespace(destinationPath),
    ];
    try {
        await runShellCommand('rsync', baseOptions, { shell: true });
    } catch (e: any) {
        console.log('Initial RSYNC attempt failed: ', e.toString());
        // Try again, this time without `-s` option & quotes around source path
        baseOptions[4] = `'${baseOptions[4]}'`;
        await runShellCommand('rsync', baseOptions.slice(1), { shell: true });
    }
    return destinationPath;
}
