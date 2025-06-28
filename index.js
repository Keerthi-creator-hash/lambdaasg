const {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand
} = require("@aws-sdk/client-auto-scaling");

const {
  EC2Client,
  DescribeImagesCommand,
  CreateImageCommand,
  CopyImageCommand,
  DeregisterImageCommand,
  DeleteSnapshotCommand
} = require("@aws-sdk/client-ec2");

const REGION        = "us-east-1";
const TARGET_REGION = "ap-southeast-2";
const ASG_NAMES     = ["my-auto", "my- asg"];  

const ec2        = new EC2Client({ region: REGION });
const ec2Target  = new EC2Client({ region: TARGET_REGION });
const asgClient  = new AutoScalingClient({ region: REGION });

const today = () => new Date().toISOString().split("T")[0];

exports.handler = async () => {
  try {
    for (const asgName of ASG_NAMES) {
      /* 1️  Get an InService instance */
      const { AutoScalingGroups = [] } = await asgClient.send(
        new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] })
      );
      const instanceId =
        AutoScalingGroups[0]?.Instances?.find(i => i.LifecycleState === "InService")?.InstanceId;
      if (!instanceId) {
        console.warn(`  No running instance found in ASG: ${asgName}`);
        continue;
      }

      /* 2️  Create AMI */
      const dateTag = today();
      const srcAmi  = (
        await ec2.send(new CreateImageCommand({
          InstanceId: instanceId,
          Name:       `${asgName}-Backup-${dateTag}`,
          Description:`Backup of ${instanceId} on ${dateTag}`,
          TagSpecifications: [{
            ResourceType: "image",
            Tags: [
              { Key: "CreatedBy",  Value: "cron" },
              { Key: "BackupDate", Value: dateTag }
            ]
          }]
        }))
      ).ImageId;
      console.log(` AMI created: ${srcAmi}`);

      /* Wait until source AMI is available */
      for (let state = "pending"; state !== "available"; ) {
        await new Promise(r => setTimeout(r, 15000));
        state = (
          await ec2.send(new DescribeImagesCommand({ ImageIds: [srcAmi] }))
        ).Images?.[0]?.State;
        console.log(` ${srcAmi} state: ${state}`);
      }

      /* 3️ Copy AMI to target region */
      const tgtAmi = (
        await ec2Target.send(new CopyImageCommand({
          SourceImageId: srcAmi,
          SourceRegion:  REGION,
          Name:          `${asgName}-Copy-${dateTag}`,
          Description:   `Copied from ${asgName} in ${REGION} on ${dateTag}`,
          TagSpecifications: [{
            ResourceType: "image",
            Tags: [
              { Key: "CreatedBy", Value: "cron" },
              { Key: "CopyDate",  Value: dateTag }
            ]
          }]
        }))
      ).ImageId;
      console.log(` Copy started: ${tgtAmi}`);

      /* Wait until copied AMI is available */
      for (let state = "pending"; state !== "available"; ) {
        await new Promise(r => setTimeout(r, 15000));
        state = (
          await ec2Target.send(new DescribeImagesCommand({ ImageIds: [tgtAmi] }))
        ).Images?.[0]?.State;
        console.log(` Copy ${tgtAmi} state: ${state}`);
      }
      console.log(` Copy complete: ${tgtAmi}`);

      /* 4️ Delete source AMI and its snapshots */
      const srcInfo = await ec2.send(new DescribeImagesCommand({ ImageIds: [srcAmi] }));
      const srcSnaps = (srcInfo.Images?.[0]?.BlockDeviceMappings || [])
                       .map(b => b.Ebs?.SnapshotId)
                       .filter(Boolean);

      await ec2.send(new DeregisterImageCommand({ ImageId: srcAmi }));
      for (const snap of srcSnaps)

        await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snap }));
      console.log(` Deleted ${srcAmi} and ${srcSnaps.length} snapshots`);
    }

    /* 5️ Purge copied AMIs older than 7 days */
    const { Images = [] } = await ec2Target.send(new DescribeImagesCommand({
      Owners: ["self"],
      Filters: [{ Name: "tag:CreatedBy", Values: ["cron"] }]
    }));
    const limit = 7 * 24 * 60 * 60 * 1000;
    const now   = Date.now();

    for (const img of Images) {
      if (now - new Date(img.CreationDate).getTime() > limit) {
        await ec2Target.send(new DeregisterImageCommand({ ImageId: img.ImageId }));
        const snaps = (img.BlockDeviceMappings || [])
                      .map(b => b.Ebs?.SnapshotId)
                      .filter(Boolean);
        for (const s of snaps)
          await ec2Target.send(new DeleteSnapshotCommand({ SnapshotId: s }));
        console.log(` Purged ${img.ImageId} & ${snaps.length} snaps`);
      }
    }

    return { statusCode: 200, body: " Backups finished, copies done, cleanup complete." };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message };
  }
};
