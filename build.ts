import {
  ImageBuilder,
  MemDirectory,
  MemFile,
  addFiles,
  rmFiles,
  run,
} from "buildahcker";
import { apkAdd, apkRemoveApk, defaultCacheOptions } from "buildahcker/alpine";
import { grubBiosInstall } from "buildahcker/alpine/grub";
import { mksquashfs } from "buildahcker/alpine/mksquashfs";
import {
  PartitionType,
  parted,
  writePartitions,
} from "buildahcker/alpine/partitions";
import { stat } from "fs/promises";
import { join } from "path";

async function createImage() {
  const cacheOptions = await defaultCacheOptions();
  const logger = process.stderr;
  const outputFolder = join(import.meta.dirname, "output");

  const builder = await ImageBuilder.from("alpine:latest", {
    logger,
    commitOptions: {
      timestamp: 0,
    },
    ...cacheOptions,
  });

  await builder.executeStep([
    addFiles({
      "etc/mkinitfs": new MemDirectory({ content: {} }),
      "etc/mkinitfs/mkinitfs.conf": new MemFile({
        content: `disable_trigger=1\n`,
      }),
      "etc/update-grub.conf": new MemFile({ content: "disable_trigger=1" }),
    }),
    apkAdd(
      [
        "alpine-conf",
        "grub-bios",
        "grub",
        "ifstate",
        "linux-firmware-none",
        "linux-lts",
        "openrc",
      ],
      {
        ...cacheOptions,
      }
    ),
    run(["rc-update", "add", "ifstate"]),
    run(["setup-keymap", "fr", "fr"]),
    run(["setup-hostname", "alpine"]),
    run(["setup-timezone", "-z", "Europe/Paris"]),
    run(["passwd", "-d", "root"]),
    addFiles({
      "etc/mkinitfs/mkinitfs.conf": new MemFile({
        content: `features="base keymap kms virtio squashfs"\ndisable_trigger=1\n`,
      }),
      "run-mkinitfs": new MemFile({
        content: `#!/bin/sh\nmkinitfs $(ls /lib/modules)`,
        mode: 0o744,
      }),
    }),
    run(["/run-mkinitfs"]),
    rmFiles(["/run-mkinitfs"]),
    addFiles({
      "etc/resolv.conf": new MemFile({ content: "nameserver 10.0.2.3" }),
      "etc/ifstate": new MemDirectory({ content: {} }),
      "etc/ifstate/config.yml": new MemFile({
        content: `
interfaces:
 - name: eth0
   addresses:
    - "10.0.2.15/24"
   sysctl:
    ipv6:
     disable_ipv6: 1
   link:
    state: up
    kind: physical
    businfo: '0000:00:02.0'
routing:
 routes:
  - to: "0.0.0.0/0"
    via: 10.0.2.2
    dev: eth0
`,
      }),
    }),

    // Remove apk itself and mkinitfs
    apkRemoveApk(["mkinitfs"], process.stderr),
  ]);
  console.log("Created image:", builder.imageId);
  const squashfsImage = join(outputFolder, "squashfs.img");
  await mksquashfs({
    source: builder.imageId,
    outputFile: squashfsImage,
    logger,
    cacheOptions,
  });
  const squashfsImageSize = (await stat(squashfsImage)).size;

  const diskImage = join(outputFolder, "disk.img");
  const partitions = await parted({
    outputFile: diskImage,
    partitions: [
      {
        name: "grub",
        size: 100000,
        type: PartitionType.BiosBoot,
      },
      {
        name: "linux",
        size: squashfsImageSize,
        type: PartitionType.LinuxData,
      },
    ],
    cacheOptions,
    logger,
  });
  await writePartitions({
    outputFile: diskImage,
    partitions: [
      {
        inputFile: squashfsImage,
        output: partitions[1],
      },
    ],
  });
  await grubBiosInstall({
    imageFile: diskImage,
    partition: partitions[0],
    modules: ["biosdisk", "part_gpt", "squash4"],
    prefix: "(hd0,2)/usr/lib/grub",
    config: `
insmod linux
linux (hd0,2)/boot/vmlinuz-lts root=/dev/vda2
initrd (hd0,2)/boot/initramfs-lts
boot
`,
    cacheOptions,
    logger,
  });
}

createImage();
