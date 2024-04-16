import {
  DiskFile,
  ImageBuilder,
  MemDirectory,
  MemFile,
  abpartitionsDisk,
  abpartitionsRootPartition,
  addFiles,
  apkAdd,
  apkRemoveApk,
  copyFileInImage,
  defaultApkCache,
  defaultContainerCache,
  run,
  sshKeygen,
} from "buildahcker";
import { readdir } from "fs/promises";
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
  const configFolder = join(import.meta.dirname, "config", configName);

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
        "busybox-mdev-openrc",
        "grub",
        "ifstate",
        "linux-firmware-none",
        "linux-lts",
        "openrc",
        "openssh",
      ],
      {
        ...commonOptions,
      }
    ),
    run(["rc-update", "add", "mdev"]),
    run(["rc-update", "add", "hwdrivers"]),
    run(["rc-update", "add", "hostname"]),
    run(["rc-update", "add", "ifstate"]),
    run(["rc-update", "add", "sshd"]),
    run(["setup-keymap", "fr", "fr"]),
    run(["setup-timezone", "-z", "Europe/Paris"]),
    run(["passwd", "-d", "root"]),
    addFiles({
      "etc/init.d/buildahcker-ab-reboot": new MemFile({
        content: `#!/sbin/openrc-run
name="buildahcker-ab-reboot"
description="Reboots if the current A/B partition is not marked as stable soon enough after restarting."
start() {
  if ! buildahckerABTool is-stable ; then
    (
      sleep 120
      if ! buildahckerABTool is-stable ; then
        reboot
      fi
    ) &
  fi
}
`,
        mode: 0o555,
      }),
      "etc/mkinitfs/mkinitfs.conf": new MemFile({
        content: `features="base keymap kms usb ata scsi virtio squashfs"\ndisable_trigger=1\n`,
      }),
    }),
    run(["rc-update", "add", "buildahcker-ab-reboot"]),
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
      "etc/resolv.conf": new DiskFile(join(configFolder, "resolv.conf"), {}),
      "etc/hostname": new DiskFile(join(configFolder, "hostname"), {}),
      "etc/ifstate": new MemDirectory(),
      "etc/ifstate/config.yml": new DiskFile(
        join(configFolder, "ifstate.yml"),
        {}
      ),
    }),
    addFiles({
      "root/.ssh": new MemDirectory(),
      "root/.ssh/authorized_keys": (
        await sshKeygen({
          prefix: "id_",
          suffix: "",
          outputFolder: join(configFolder, "ssh"),
          ...commonOptions,
        })
      )["id_ed25519.pub"],
      "etc/ssh": new MemDirectory({
        content: {
          ...(await sshKeygen({
            outputFolder: join(configFolder, "ssh"),
            ...commonOptions,
          })),
        },
      }),
    }),
    // Remove apk itself and mkinitfs
    apkRemoveApk(["mkinitfs"], process.stderr),
  ]);
  console.log("Created image:", builder.imageId);
  const rootPartition = await abpartitionsRootPartition({
    sourceRootImage: builder.imageId,
    ...commonOptions,
  });
  const disk = await abpartitionsDisk({
    rootPartition,
    rootPartitionSize: 300 * 1024 * 1024,
    ...commonOptions,
  });
  const rootImage = join(outputFolder, "root.img");
  await copyFileInImage(rootPartition, rootImage);
  const diskImage = join(outputFolder, "disk.img");
  await copyFileInImage(disk, diskImage);
}

createImage(process.argv[2]);
