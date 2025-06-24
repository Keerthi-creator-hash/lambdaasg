const AWS = require('aws-sdk');
const ec2 = new AWS.EC2();
const autoscaling = new AWS.AutoScaling();

const TARGET_REGION = 'ap-southeast-2'; // Sydney
const ASG_NAMES = ['my-asg', 'my-auto'];

const ec2TargetRegion = new AWS.EC2({ region: TARGET_REGION });

exports.handler = async (event, context) => {
    const today = new Date().toISOString().split('T')[0];

    for (const asgName of ASG_NAMES) {
        console.log(`Processing ASG: ${asgName}`);

        try {
            const asgResponse = await autoscaling.describeAutoScalingGroups({
                AutoScalingGroupNames: [asgName]
            }).promise();

            if (!asgResponse.AutoScalingGroups || asgResponse.AutoScalingGroups.length === 0) {
                console.log(`No ASG found with name ${asgName}`);
                continue;
            }

            const asg = asgResponse.AutoScalingGroups[0];
            const instanceIds = asg.Instances.map(instance => instance.InstanceId);

            if (instanceIds.length === 0) {
                console.log(`No instances found in ASG ${asgName}`);
                continue;
            }

            for (const instanceId of instanceIds) {
                try {
                    console.log(`Fetching AMI for instance ${instanceId}`);

                    const instanceDetails = await ec2.describeInstances({
                        InstanceIds: [instanceId]
                    }).promise();

                    const imageId = instanceDetails.Reservations[0].Instances[0].ImageId;
                    const time = new Date().toISOString().split('T')[1].replace(/:/g, '-').split('.')[0];
                    const amiName = `${asgName}-${instanceId}-${today}-${time}`;

                    console.log(`Copying AMI ${imageId} to ${TARGET_REGION}`);

                    const copyImageRes = await ec2TargetRegion.copyImage({
                        SourceImageId: imageId,
                        SourceRegion: process.env.AWS_REGION,
                        Name: `Copy-${amiName}`,
                        Description: `Copied AMI ${imageId} of ${asgName} instance ${instanceId}`,
                    }).promise();

                    console.log(`Copied AMI to ${TARGET_REGION}: ${copyImageRes.ImageId}`);
                } catch (err) {
                    console.error(`Error processing instance ${instanceId}: ${err.message}`);
                }
            }

        } catch (err) {
            console.error(`Failed to process ASG ${asgName}: ${err.message}`);
        }
    }
};
