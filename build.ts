import {
  DiskFile,
  ImageBuilder,
  MemDirectory,
  MemFile,
  PartitionType,
  addFiles,
  apkAdd,
  apkRemoveApk,
  defaultApkCache,
  defaultContainerCache,
  grubBiosSetup,
  grubMkimage,
  mksquashfs,
  parted,
  run,
  temporaryContainer,
  writePartitions,
} from "buildahcker";
import { readdir, stat } from "fs/promises";
import { join } from "path";

const validConfig = ["qemu"];

async function createImage(configName: string) {
  if (!validConfig.includes(configName)) {
    throw new Error(
      `Invalid config name, should be one of ${validConfig.join(", ")}`
    );
  }
  const commonOptions = {
    containerCache: defaultContainerCache(),
    apkCache: defaultApkCache(),
    logger: process.stderr,
  };
  const outputFolder = join(import.meta.dirname, "output", configName);

  const builder = await ImageBuilder.from("alpine:latest", {
    commitOptions: {
      timestamp: 0,
    },
    ...commonOptions,
  });

  await builder.executeStep([
    addFiles({
      "etc/mkinitfs": new MemDirectory(),
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
        ...commonOptions,
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
      "etc/ifstate": new MemDirectory(),
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
  await temporaryContainer(builder.imageId, async (container) => {
    await mksquashfs({
      inputFolder: await container.mount(),
      outputFile: squashfsImage,
      ...commonOptions,
    });
  });
  const squashfsImageSize = (await stat(squashfsImage)).size;
  const grubCore = join(outputFolder, "grub-core.img");
  const grubBoot = join(outputFolder, "grub-boot.img");
  await grubMkimage({
    outputCoreFile: grubCore,
    outputBootFile: grubBoot,
    grubSource: builder.imageId,
    target: "i386-pc",
    modules: ["biosdisk", "part_gpt", "squash4"],
    prefix: "(hd0,2)/usr/lib/grub",
    config: `
insmod linux
linux (hd0,2)/boot/vmlinuz-lts root=/dev/sda2
initrd (hd0,2)/boot/initramfs-lts
boot
`,
    ...commonOptions,
  });
  const grubCoreImageSize = (await stat(grubCore)).size;
  const diskImage = join(outputFolder, "disk.img");
  const partitions = await parted({
    outputFile: diskImage,
    partitions: [
      {
        name: "grub",
        size: grubCoreImageSize,
        type: PartitionType.BiosBoot,
      },
      {
        name: "linux",
        size: squashfsImageSize,
        type: PartitionType.LinuxData,
      },
    ],
    ...commonOptions,
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
  await grubBiosSetup({
    imageFile: diskImage,
    partition: partitions[0],
    bootFile: grubBoot,
    coreFile: grubCore,
    ...commonOptions,
  });
}

createImage(process.argv[2]);
