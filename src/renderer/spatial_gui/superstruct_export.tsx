// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

//
// Wrapper that loads superstruct (json validator) through skypack, or locally...
// We need to use skypack for deno/CI runs in ll-sw, but we should switch it off to local import
// for production.
//
// import { object, assert, string, number, array } from 'https://cdn.skypack.dev/superstruct';
import { array, assert, boolean, enums, number, object, string, tuple } from 'superstruct';
// import * as superstruct from 'https://cdn.skypack.dev/superstruct';

// console.log(superstruct);

export { object, assert, string, number, array, boolean, tuple, enums };
