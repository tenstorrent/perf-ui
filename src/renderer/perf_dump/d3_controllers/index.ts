// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import PerfDumpD3Controller from './perf_dump_d3';
import NcriscD3Controller from './ncrisc_dump_d3';
import PerCoreD3Controller from './perf_dump_per_core_d3';
import GraphD3Controller from './perf_graph';
import FboDumpD3 from './fbo_dump_d3';

type D3Controller = PerfDumpD3Controller | NcriscD3Controller | PerCoreD3Controller | GraphD3Controller;
export { D3Controller, PerfDumpD3Controller, NcriscD3Controller, PerCoreD3Controller, GraphD3Controller, FboDumpD3 };
