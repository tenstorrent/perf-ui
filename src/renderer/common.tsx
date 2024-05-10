// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import { ChildProcess, SpawnSyncOptionsWithBufferEncoding, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { Button } from '@blueprintjs/core';

import { Workspace } from './config';

export const OP_COLORS = [
    'rgb(57,146,131)',
    'rgb(74,217,225)',
    'rgb(10,79,78)',
    'rgb(136,217,141)',
    'rgb(91,131,19)',
    'rgb(152,218,29)',
    'rgb(26,79,163)',
    'rgb(164,126,224)',
    'rgb(65,165,238)',
    'rgb(114,53,155)',
    'rgb(228,91,199)',
    'rgb(90,62,79)',
    'rgb(252,194,251)',
    'rgb(148,43,243)',
    'rgb(202,215,212)',
    'rgb(125,68,0)',
    'rgb(250,163,140)',
    'rgb(196,54,33)',
    'rgb(247,147,30)',
    'rgb(156,26,84)',
    'rgb(227,215,105)',
    'rgb(132,132,132)',
    'rgb(23,244,111)',
];

export const EpochChooser = ({ value, options, handleEpochSelect }) => {
    const valueIndex = options.indexOf(value);

    const optionsList = options.map((e) => {
        if (e == value) {
            return (
                <div className="epoch-selected" key={e}>
                    {e}
                </div>
            );
        }
        return (
            <a className="epoch-choice" key={e} onClick={() => handleEpochSelect(e)}>
                {e}
            </a>
        );
    });

    return (
        <div className="epoch-picker-div">
            <span className="epoch-text">Epoch:</span>
            <Button
                icon="double-chevron-left"
                intent="primary"
                onClick={() => handleEpochSelect(options[valueIndex - 1])}
                disabled={valueIndex == 0}
            />
            <Button
                icon="double-chevron-right"
                intent="primary"
                onClick={() => handleEpochSelect(options[valueIndex + 1])}
                disabled={valueIndex == options.length - 1}
            />
            {optionsList}
        </div>
    );
};

export function debounce(fn, ms, ...args) {
    let timer;
    return (_) => {
        clearTimeout(timer);
        timer = setTimeout((_) => {
            timer = null;
            fn.apply(this, ...args);
        }, ms);
    };
}

export const isChecked = (ev: any): boolean => {
    return (ev.target as HTMLInputElement).checked;
};

export const setCompare = (a: Set<unknown>, b: Set<unknown>): boolean => {
    if (a.size != b.size) {
        return false;
    }
    for (const el_a of a) {
        if (!b.has(el_a)) {
            return false;
        }
    }

    return true;
};

export const setDiff = <T extends unknown>(a: Set<T>, b: Set<T>): Set<T> => {
    const ret = new Set<T>();
    for (const el_a of a) {
        if (!b.has(el_a)) {
            ret.add(el_a);
        }
    }
    return ret;
};

/** Runs a shell command and returns the output buffers on success (status=0).
 *
 * @param timeout: Pass this timeout (ms) to spawnSync options. Throws error on timeout.
 *
 * Throws error on failure (nonzero status). */
export async function runShellCommand(
    cmd: string,
    params: string[],
    options?: SpawnSyncOptionsWithBufferEncoding,
): Promise<[stdout: Buffer | null, stderr: Buffer | null]> {
    console.log('RUN COMMAND: ', cmd, params);
    const result = spawnSync(cmd, params, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
    });
    const [_, stdout, stderr] = result.output;
    if (result.error) {
        throw result.error;
    }
    if (result.status != 0) {
        throw Error(`Command ${cmd} failed with status ${result.status}.\n${result.stderr.toString()}`);
    }
    return [stdout, stderr];
}

export function sshWrapCmd(w: Workspace, cmd: string): string[] {
    return [
        w.sshHost!,
        '-p',
        w.sshPort!, // remote connection
        'bash',
        '-c',
        `'${cmd}'`,
    ];
}

export function spawnWithStdioHandlers(
    cmd: string,
    params: readonly string[],
    processLabel: string,
    logStdio = true,
): ChildProcess {
    console.log(`Spawning ${processLabel}: ${cmd} ${params.join(' ')}`);
    const process = spawn(cmd, params, { stdio: 'pipe' });

    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');

    if (logStdio) {
        process.stdout.on('data', (data) => {
            console.log(`${processLabel} (stdout): `, data);
        });
        process.stderr.on('data', (data) => {
            console.warn(`${processLabel} (stderr): `, data);
        });
    }
    return process;
}

export function fnvHash(str: string): number {
    const FNV_offset_basis = 2166136261;
    const FNV_prime = 16777619;
    return (
        Array.from(str).reduce(
            (s: number, c: string) => Math.imul(s, FNV_prime) ^ c.charCodeAt(0),
            FNV_offset_basis,
        ) >>> 0
    );
}

export function getWorkspaceId(w: Workspace): string {
    console.log(`WORKSPACE PATH: ${w.path}`);
    const hash = fnvHash(w.path);
    if (w.remote) {
        const remoteString = `${hash}-${w.sshHost}`;
        console.log(`REMOTE WORKSPACE ID: ${remoteString}`);
        return remoteString;
    }
    return hash.toString();
}

export const escapeWhitespace = (str: string) => str.replace(/(\s)/g, '\\$1');

/** Generates an array of full paths to the subdirectories under a given path */
export const findSubDirectories = (folderPath: string): string[] =>
    fs
        .readdirSync(folderPath)
        .map((subFolder) => path.join(folderPath, subFolder))
        .filter((fullFolderPath) => fs.lstatSync(fullFolderPath).isDirectory());
