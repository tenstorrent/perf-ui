// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

// A simple test to verify a visible window is opened with a title
import '@testing-library/jest-dom';

const { Application } = require('spectron');
const assert = require('assert');

const myApp = new Application({
    // path: '/Applications/MyApp.app/Contents/MacOS/MyApp'
    path: 'release/mac/perf-ui.app/Contents/MacOS/perf-ui',
});

const verifyWindowIsVisibleWithTitle = async (app) => {
    await app.start();
    try {
        // Check if the window is visible
        const isVisible = await app.browserWindow.isVisible();
        console.log('Is visible is', isVisible);
        // Verify the window is visible
        assert.strictEqual(isVisible, true);
        // Get the window's title
        const title = await app.client.getTitle();
        // Verify the window's title
        console.log('Title is', title);
        assert.strictEqual(title, 'My App');
    } catch (error) {
        // Log any failures
        console.error('Test failed', error.message);
    }
    // Stop the application
    console.log('Stopping the app');
    await app.stop();
};

describe('sanity', () => {
    it('should open', () => {
        expect(verifyWindowIsVisibleWithTitle(myApp)).toBeTruthy();
    });
});
