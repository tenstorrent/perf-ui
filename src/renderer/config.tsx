// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import fs from 'fs';
import path from 'path';

const CONFIG_FILENAME = 'config.json';

const CURRENT_VERSION = 0;

export interface Workspace {
    remote: boolean;
    sshHost?: string;
    sshPort?: string;
    path: string;
    outputPath: string;
}

export interface IConfig {
    workspaces: Array<Workspace>;
    storageVersion?: number;
}

export enum AppMode {
    PICK_WORKSPACE,
    PERF_DUMP,
}

export const workspaceToString = (w: Workspace): string => {
    if (w.remote) {
        return `ssh://${w.sshHost}:${w.sshPort}${w.path}`;
    }
    return w.path;
};

export const workspaceCompare = (w1: Workspace, w2: Workspace): boolean => {
    if (w1.remote !== w2.remote) {
        return false;
    }
    if (w1.path !== w2.path) {
        return false;
    }
    if (w1.outputPath !== w2.outputPath) {
        return false;
    }

    if (w1.remote) {
        if (w1.sshHost !== w2.sshHost) {
            return false;
        }
        if (w1.sshPort !== w2.sshPort) {
            return false;
        }
    }

    return true;
};

export const verifyLocalWorkspace = (w: Workspace): boolean => {
    if (!w.remote) {
        return fs.existsSync(w.path);
    }
    throw Error('Workspace is not local');
};

const getDefaultAppConfig = (): IConfig => ({
    workspaces: [],
    storageVersion: CURRENT_VERSION,
});

const getConfigPaths = async (): Promise<[configDir: string, fullFilename: string]> => {
    const remote = await import('@electron/remote');
    const configDir = remote.app.getPath('userData');
    return [configDir, path.join(configDir, CONFIG_FILENAME)];
};

const loadConfig = async (): Promise<IConfig> => {
    const [configDir, fullFilename] = await getConfigPaths();
    if (!fs.existsSync(configDir)) {
        return getDefaultAppConfig();
    }

    if (!fs.existsSync(fullFilename)) {
        return getDefaultAppConfig();
    }

    console.log('Loading config from ', fullFilename);

    const rawdata = fs.readFileSync(path.resolve(fullFilename));
    try {
        const config: IConfig = JSON.parse(rawdata.toString());
        if (config.storageVersion === undefined) {
            console.log('No version in config, adding version');
            config.storageVersion = 0;
            await storeConfig(config);
        }
        return config;
    } catch (e) {
        console.log('Invalid config, defaulting to normal');
        return getDefaultAppConfig();
    }
};

const storeConfig = async (config: IConfig): Promise<void> => {
    const [configDir, fullFilename] = await getConfigPaths();
    if (!fs.existsSync(configDir)) {
        await new Promise((resolve, _reject) => {
            fs.mkdir(configDir, resolve);
        });
    }

    console.log('Updating config with ', config);
    await new Promise((resolve, _reject) => {
        fs.writeFile(path.resolve(fullFilename), JSON.stringify(config, null, 2), resolve);
    });
};

export { loadConfig, storeConfig };
