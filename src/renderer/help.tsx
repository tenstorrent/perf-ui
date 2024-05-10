// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC.

import React, { useState } from 'react';
import { Button, Dialog } from '@blueprintjs/core';

const HelpContent = ({ helpKey }) => {
    switch (helpKey) {
        case 'workspace':
            return (
                <div>
                    <p>
                        Workspace is the directory where PerfUI will look for perf dumps, i.e. <code>perf_results</code>{' '}
                        subdirectories.
                    </p>
                    <p>This can be on the local machine, or a remote SSH-accesible machine or docker container.</p>
                    <p>
                        Workspaces are usually directories in which Buda compiler, tests, model, and other code is
                        located, but these items are not necessary to load perf dumps.
                    </p>
                    <p>
                        For local files, you can also use the &ldquo;Local Only&rdquo; mode &#40;orange button&#41;
                        instead of a workspace.
                    </p>
                </div>
            );
    }
    return <div />;
};

// Display a clickable work/text that will open up help under helpKey
const HelpText = ({ helpKey, helpText }) => {
    const [showHelp, setShowHelp] = useState(false);

    return (
        <span
            onMouseDown={() => {
                setShowHelp(true);
            }}
            className="help-text"
        >
            {helpText}
            <Help
                showHelp={showHelp}
                helpKey={helpKey}
                handleClose={() => {
                    setShowHelp(false);
                }}
            />
        </span>
    );
};

const Help = ({ showHelp, helpKey, handleClose }) => {
    return (
        <Dialog icon="help" isOpen={showHelp} title={helpKey} onClose={handleClose}>
            <div className="help-content">
                <HelpContent helpKey={helpKey} />
            </div>
            <Button text="Thanks!" onClick={handleClose} style={{ maxWidth: '50%', margin: 'auto' }} />
        </Dialog>
    );
};

export { Help, HelpText };
