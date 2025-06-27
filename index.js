const {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand
  } = require("@aws-sdk/client-auto-scaling");
  
  const {
    EC2Client,
    DescribeInstancesCommand,
    CreateImageCommand,
    DescribeImagesCommand,
    CopyImageCommand,
    DeregisterImageCommand,
    DeleteSnapshotCommand
  } = require("@aws-sdk/client-ec2");
  
  const REGION = "us-east-1";
  const TARGET_REGION = "ap-southeast-2";
  const ASG_NAME = "my-auto";
  
  const ec2 = new EC2Client({ region: REGION });
  const ec2Target = new EC2Client({ region: TARGET_REGION });
  const asgClient = new AutoScalingClient({ region: REGION });
  
  const getTodayDate = () => new Date().toISOString().split("T")[0];
  
  exports.handler = async () => {
    try {
      // Step 1: Get instance ID from ASG
      const asgRes = await asgClient.send(
        new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [ASG_NAME] })
      );
      const instanceId = asgRes.AutoScalingGroups?.[0]?.Instances?.find(i => i.LifecycleState === "InService")?.InstanceId;
      if (!instanceId) throw new Error("No running instance found in ASG");
  
      // Step 2: Create new AMI from instance
      const dateTag = getTodayDate();
      const backupAmiName = `${ASG_NAME}-Backup-${dateTag}`;
  
      const createRes = await ec2.send(new CreateImageCommand({
        InstanceId: instanceId,
        Name: backupAmiName,
        Description: `Automated backup on ${dateTag}`,
        TagSpecifications: [{
          ResourceType: "image",
          Tags: [
            { Key: "CreatedBy", Value: "cron" },
            { Key: "BackupDate", Value: dateTag }
          ]
        }]
      }));
      const newAmiId = createRes.ImageId;
      console.log("Created AMI:", newAmiId);
  
      // Step 3: Wait until AMI is available
      let state = "pending";
      while (state !== "available") {
        await new Promise(res => setTimeout(res, 15000));
        const res = await ec2.send(new DescribeImagesCommand({ ImageIds: [newAmiId] }));
        state = res.Images?.[0]?.State;
        console.log(` Waiting... AMI state: ${state}`);
      }
  
      // Step 4: Copy AMI to target region
      const copyAmiName = `${ASG_NAME}-Copy-${dateTag}`;
      const copyRes = await ec2Target.send(new CopyImageCommand({
        SourceImageId: newAmiId,
        SourceRegion: REGION,
        Name: copyAmiName,
        Description: `Copied from ${REGION} on ${dateTag}`,
        TagSpecifications: [{
          ResourceType: "image",
          Tags: [
            { Key: "CreatedBy", Value: "cron" },
            { Key: "CopyDate", Value: dateTag }
          ]
        }]
      }));
      console.log("Copied AMI to target region:", copyRes.ImageId);
  
      // Step 5: Delete the created AMI and its snapshots in source region
      const createdAmiDetails = await ec2.send(new DescribeImagesCommand({ ImageIds: [newAmiId] }));
      const snapshotsToDelete = createdAmiDetails.Images?.[0]?.BlockDeviceMappings?.map(
        d => d.Ebs?.SnapshotId
      ).filter(Boolean) || [];
  
      console.log(`Deregistering source AMI: ${newAmiId}`);
      await ec2.send(new DeregisterImageCommand({ ImageId: newAmiId }));
  
      for (const snapId of snapshotsToDelete) {
        console.log(` Deleting snapshot in source region: ${snapId}`);
        await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapId }));
      }
  
      // Step 6: Cleanup AMIs older than 7 days in target region
      const { Images = [] } = await ec2Target.send(new DescribeImagesCommand({
        Owners: ['self'],
        Filters: [
          { Name: 'tag:CreatedBy', Values: ['cron'] }
        ]
      }));
  
      const now = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  
      for (const image of Images) {
        const createdTime = new Date(image.CreationDate).getTime();
        const ageMs = now - createdTime;
  
        if (ageMs > sevenDaysMs) {
          console.log(` Deregistering AMI older than 7 days: ${image.ImageId}`);
          await ec2Target.send(new DeregisterImageCommand({ ImageId: image.ImageId }));
  
          const snapIds = image.BlockDeviceMappings?.map(b => b.Ebs?.SnapshotId).filter(Boolean);
          for (const snapId of snapIds) {
            console.log(`Deleting snapshot in target region: ${snapId}`);
            await ec2Target.send(new DeleteSnapshotCommand({ SnapshotId: snapId }));
          }
        } else {
          console.log(` Retaining AMI (less than 7 days old): ${image.ImageId}`);
        }
      }
  
      return {
        statusCode: 200,
        body: ` AMI ${newAmiId} created, copied, source deleted, and old AMIs cleaned from target region.`
      };
  
    } catch (err) {
      console.error(" Error:", err);
      return {
        statusCode: 500,
        body: JSON.stringify(err)
      };
    }
  };
