// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

import React from 'react';

import { InputGroup, Tab, Tabs } from '@blueprintjs/core';

import EasterEgg from '../ratatouille.png';
import { ConsoleLine, ConsoleText } from '../spatial_gui/console_text';

interface PerfConsoleProps {
    imgRef: React.RefObject<HTMLImageElement>;
    tabId: string;
    setTabId: (t: string) => void;
    consoleText: ConsoleLine[];
    outputText: ConsoleLine[];
    cmdValue: string;
    setCmdValue: (v: string) => void;
    handleKey: (e: React.KeyboardEvent) => void;
    hide: boolean;
}

export default function PerfConsole({
    imgRef,
    tabId,
    setTabId,
    consoleText,
    outputText,
    cmdValue,
    setCmdValue,
    handleKey,
    hide,
}: PerfConsoleProps): React.ReactElement {
    if (hide) {
        return <div />;
    }
    return (
        <div className="console bp4-dark">
            <img className="easter-egg" src={EasterEgg} ref={imgRef} alt="easter egg" />
            <Tabs
                className="console-tabs"
                selectedTabId={tabId}
                onChange={(t: string) => {
                    setTabId(t);
                }}
            >
                <Tab
                    id="tab-console"
                    title="Console"
                    panel={
                        <>
                            <ConsoleText content={consoleText} autoScroll height="100" />
                            <div className="console-input">
                                <InputGroup
                                    leftIcon="chevron-right"
                                    onKeyUp={handleKey}
                                    onChange={(e) => {
                                        setCmdValue(e.target.value);
                                    }}
                                    value={cmdValue}
                                />
                            </div>
                        </>
                    }
                />
                <Tab
                    id="tab-output"
                    title="Output"
                    panel={<ConsoleText content={outputText} autoScroll height="100" />}
                />
            </Tabs>
        </div>
    );
}
