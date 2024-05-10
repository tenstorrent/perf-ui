// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent AI ULC

import React from 'react';

import { Alert } from '@blueprintjs/core';

const ErrorMessage = ({ message }) => {
    return (
        <>
            {message.split('\n').map((msg, i) => (
                <p key={i.toString()}>
                    {' '.repeat(i * 2)}
                    {msg}
                </p>
            ))}
        </>
    );
};

export interface IErrorModalProps {
    errorMessage: string;
    showError: boolean;
    setError: (errorMessage: string) => void;
    setShowError: (showError: boolean) => void;
}

/*
 */
export const ErrorModal = ({ errorMessage, showError, setError, setShowError }) => {
    return (
        <Alert
            intent="danger"
            className="alert"
            isOpen={showError}
            onClose={() => {
                setShowError(false);
                console.log(`Clearing error message: ${errorMessage}`);
                setError('');
            }}
        >
            <ErrorMessage message={errorMessage} />
        </Alert>
    );
};
