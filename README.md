## Overview

Route-a-GUI is a Tenstorrent IDE for BUDA development. It can display models, performance data, routing, placement, etc., and it will be able to interact with the compiler to modify and tune model
parameters.

It is currently in development, so things change significantly every day.

## Development Env Setup Instructions

### CentOS

Install latest NodeJS. v18.16.x is recommended. `sudo apt install nodejs`. It is possible to manually install nodejs without root access, if needed (google for instructions).

Confirm that node is at least 18.16.x

Then, run `npm install` in project root to install all dependencies.

### Ubuntu

Try `node -v`, and if it's absent or older than 18.16.x, then you need to install the latest:

```
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - &&\
sudo apt-get install -y nodejs
```

Then, run `npm install` in project root to install dependencies.

### Mac

You can install nodeJS with Homebrew, or use `nvm` to support multiple versions.

To use Homebrew: `brew install node@18`

Alternatively, To use `nvm`, follow the installation instructions (here)[https://github.com/nvm-sh/nvm#install--update-script] and then install node v18

In either case, verify the version by running `node -v`.

Then, run `npm install` in the project root to install dependencies.

## Run

To run Route-a-GUI in development mode, run `npm start`.

## Package for Release

To build a binary for the local OS, run `npm run package`. The binar(y/ies) will be in `release/build/` directory.

### Linux

On Linux, this will create an AppImage file that can run on any Linux OS. Some CentOS versions do not have kernel sandboxing enabled by default, and will fail to run with a message about sandbox not
being properly configured. There are two workarounds:

1. With sudo access, sandboxing can be enabled:

```
sudo sh -c 'echo user.max_user_namespaces=15000 >/etc/sysctl.d/90-max_net_namespaces.conf'
sudo sysctl -p /etc/sysctl.d /etc/sysctl.d/90-max_net_namespaces.conf
```

2. AppImage can be run with `--no-sandbox` switch, which doesn't require root access. This, however, grants the app ability to run without a sandbox, which is less secure.

### Mac

On Mac, the electron-builder will by default try to sign the executable, but the process to notarize it and register with Apple is not set up yet. In the meantime, signing can be disabled:

```
export CSC_IDENTITY_AUTO_DISCOVERY=false
```

I have not seen any negative side-effects from this - OSX runs the app fine without any complaints. The build will create an executable binary, as well as DMG image file that can be used to
install the app. Either works.

### Windows

Windows is not supported. Some features may work if nodeJS is installed, but remote loading of perf dumps will definitely not work.
