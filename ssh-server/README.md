# Running the SSH server on your local

## Prerequisites

Install docker on your machine. You can find the installation instructions [here](https://docs.docker.com/get-docker/).

Create an SSH key pair if you don't have one already. You can do this by running the following command in your terminal:

```bash
ssh-keygen -t ed25519 -C "Local SSH server" -f ~/.ssh/<NAME OF THE KEY PAIR>
```

This will create a new SSH key pair in the `~/.ssh` folder. If you have multiple files there, you will need to find the one you just created. The key pair will be named `<NAME OF THE KEY PAIR>` for the private key and `<NAME OF THE KEY PAIR>.pub` for the public key.

Copy the **public key** to the same folder as the `Dockerfile` and name it `id_ed25519.pub`. This is the key that will be used to authenticate you to the server.

## Update your ssh config

You will have to add the permissions to use the key you created to your `~/.ssh/config` file. If you don't have this file yet, create it.

Add the following lines to the file:

```
Host localhost
  PreferredAuthentications publickey
  IdentityFile ~/.ssh/<NAME OF THE PUBLIC KEY>
```

## Running the server

Build the image using docker:

```bash
docker build --build-arg username=$(logname) -t local-ssh-image .
```

This will create a new docker image with the name `local-ssh-image` and the username set to your local username (see [Advanced build configuration](#advanced-build-configuration) for more information).

Run the server using the following command:

```bash
docker run -dit -p 2222:22 --name local-ssh-server local-ssh-image:latest
```

This will create a new container with the name `local-ssh-server` and the latest version of the image `local-ssh-image`.

The server will be running on port `2222` of your local machine.

## Connecting to the server

You can now connect to the server using the following command:

```bash
ssh -p 2222 localhost
```

You should see a message asking you to confirm the authenticity of the server. Type `yes` and press `Enter`.

If you see a bash prompt, you have successfully connected to the server.

## Advanced build configuration

### Username

You can set the **username** that will be created on the docker image by passing the `username` argument to the `docker build` command. For example:

```bash
docker build --build-arg username=your-username -t local-ssh-image .
```

To create a user with the same name as your local user, you can use the `logname` command to get your username. For example:

```bash
docker build --build-arg username=$(logname) -t local-ssh-image .
```

The default value for this argument is: `sshuser`.

### SSH key file

You can set the **ssh key file** that will be used to authenticate the user by passing the `keypath` argument to the `docker build` command. For example:

```bash
docker build --build-arg keypath=/path/to/your/key -t local-ssh-image .
```

The default value for this argument is: `./id_ed25519.pub`.

### Data folder

You can set the **data folder** containing all the tests data that will be copied to the server with the `datafolder` argument. For example:

```bash
docker build --build-arg datafolder=/path/to/your/data -t local-ssh-image .
```

The default value for this argument is: `./data`.

### Combining all arguments

You can combine all the arguments to build the image with the following command:

```bash
docker build --build-arg username=your-username --build-arg keypath=/path/to/your/key --build-arg datafolder=/path/to/your/data -t local-ssh-image .
```
