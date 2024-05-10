// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import React from 'react';
import { AppMode, Workspace } from './config';

export type SetError = (errorMessage: string, log?: boolean) => void;

export const WorkspaceContext = React.createContext<Workspace | null>(null);
export const AppModeContext = React.createContext<AppMode>(AppMode.PICK_WORKSPACE);
export const SetErrorContext = React.createContext<SetError>((err: string) => {
    throw Error(`(Handler not implemented for error context) ${err}`);
});
