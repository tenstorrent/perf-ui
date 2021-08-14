// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

type Styles = Record<string, string>;

declare module '*.svg' {
    const content: string;
    export default content;
}

declare module '*.png' {
    const content: string;
    export default content;
}

declare module '*.jpg' {
    const content: string;
    export default content;
}

declare module '*.scss' {
    const content: Styles;
    export default content;
}

declare module '*.sass' {
    const content: Styles;
    export default content;
}

declare module '*.css' {
    const content: Styles;
    export default content;
}
