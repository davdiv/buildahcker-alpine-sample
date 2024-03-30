# buildahcker-alpine-sample

This is a simple example demonstrating the use of the [buildahcker](https://github.com/davdiv/buildahcker) Node.js library to create an [Alpine Linux](https://www.alpinelinux.org/) image for booting in a virtual machine (VM).

## Dependencies

Make sure you have the following dependencies installed:

- [Buildah](https://buildah.io): buildahcker requires it to create container images
- [Node.js](https://nodejs.org): buildahcker is a Node.js library
- [QEMU](https://www.qemu.org): it can be used to run the generated image

Note that this was only tested on Linux.

## Getting Started

- Clone this repository:

```bash
git clone https://github.com/davdiv/buildahcker-alpine-sample.git
cd buildahcker-alpine-sample
```

- Install npm dependencies:

```bash
npm install
```

- Build the Alpine image:

```bash
npm run build
```

It will be generated in the `output` folder.

Note that it is configured with the french (`fr`) keyboard layout. You may want to change the configuration to match your own keyboard layout.

- Run the virtual machine with QEMU to test the image:

```bash
npm start
```

You should see QEMU booting the image. You can login as `root`. There is no password.

## Explanations

The [build.ts](./build.ts) file uses the [buildahcker](https://github.com/davdiv/buildahcker) library to create an [Alpine Linux](https://www.alpinelinux.org/) image with pre-installed packages, and customized network settings.

The script first creates a squashfs image from the Alpine base image, then writes it into a partition of a new disk image, and finally installs GRUB with a customized configuration to enable bootup in a VM.
