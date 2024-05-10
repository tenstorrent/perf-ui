// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

/** Component that displays console-like text - styled output, commands, etc. Reusable between a few tabs */
import React from 'react';
import { ReactElement, useEffect, useRef } from 'react';

export interface ConsoleLine {
    className?: string;
    content: ReactElement | string;
}

export const ConsoleText = ({
    content,
    autoScroll,
    height,
}: {
    content: ConsoleLine[];
    autoScroll: boolean;
    height: string;
}): ReactElement => {
    const consoleLastRef = useRef<HTMLDivElement>(null);

    const contentHTML = () => {
        let k = 0;
        return (
            <>
                {content.map((a) => {
                    k += 1;
                    return (
                        <div className={a.className} key={k}>
                            {a.content}
                        </div>
                    );
                })}
            </>
        );
    };

    // Auto-scroll to the bottom on text change
    useEffect(() => {
        autoScroll &&
            consoleLastRef.current &&
            consoleLastRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'end',
            });
    }, [content]);

    return (
        <div className="console-output" style={{ height, maxHeight: height }}>
            {contentHTML()}
            <div ref={consoleLastRef}>&nbsp;</div>
        </div>
    );
};
