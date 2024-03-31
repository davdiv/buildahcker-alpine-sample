import {
  DiskFile,
  ImageBuilder,
  MemDirectory,
  MemFile,
  addFiles,
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
import { readdir, stat } from "fs/promises";
import { join } from "path";

const validConfig = ["qemu"];

async function createImage(configName: string) {
  if (!validConfig.includes(configName)) {
    throw new Error(
      `Invalid config name, should be one of ${validConfig.join(", ")}`
    );
  }
  const cacheOptions = await defaultCacheOptions();
  const logger = process.stderr;
  const outputFolder = join(import.meta.dirname, "output", configName);

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
        content: `features="base keymap kms scsi virtio squashfs"\ndisable_trigger=1\n`,
      }),
    }),
    run(["mkinitfs"], {
      extraHashData: ["AUTOKERNELVERSION"],
      beforeRun: async (container, command) => {
        await container.mount();
        const kernelVersions = await readdir(
          join(container.mountPath, "lib", "modules")
        );
        if (kernelVersions.length != 1) {
          throw new Error(
            `Expected only one kernel version, found: ${kernelVersions.join(
              ", "
            )}`
          );
        }
        command.push(kernelVersions[0]);
      },
    }),
    addFiles({
      "etc/resolv.conf": new DiskFile(
        join(import.meta.dirname, "config", configName, "resolv.conf"),
        {}
      ),
      "etc/ifstate": new MemDirectory({ content: {} }),
      "etc/ifstate/config.yml": new DiskFile(
        join(import.meta.dirname, "config", configName, "ifstate.yml"),
        {}
      ),
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
linux (hd0,2)/boot/vmlinuz-lts root=/dev/sda2
initrd (hd0,2)/boot/initramfs-lts
boot
`,
    cacheOptions,
    logger,
  });
}

createImage(process.argv[2]);
