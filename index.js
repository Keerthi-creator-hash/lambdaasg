const AWS = require('aws-sdk');
const ec2 = new AWS.EC2();
const autoscaling = new AWS.AutoScaling();

const TARGET_REGION = 'ap-southeast-2'; // Sydney
const ASG_NAMES = ['my-asg', 'my-auto'];

const ec2TargetRegion = new AWS.EC2({ region: TARGET_REGION });

exports.handler = async (event, context) => {
    for (const asgName of ASG_NAMES) {
        console.log(`Processing ASG: ${asgName}`);

        try {
            const asgResponse = await autoscaling.describeAutoScalingGroups({
                AutoScalingGroupNames: [asgName]
            }).promise();

            const asg = asgResponse.AutoScalingGroups?.[0];
            if (!asg) {
                console.log(`No ASG found with name ${asgName}`);
                continue;
            }

            // Fetch the launch template specification
            const spec = asg.LaunchTemplate || asg.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification;
            console.log(`Launch template spec for ${asgName}:`, JSON.stringify(spec, null, 2));

            if (!spec) {
                console.log(`ASG ${asgName} does not use a launch template.`);
                continue;
            }

            const versionToUse = spec.Version || '$Default';
            const params = { Versions: [versionToUse] };

            if (spec.LaunchTemplateId) {
                params.LaunchTemplateId = spec.LaunchTemplateId;
            } else if (spec.LaunchTemplateName) {
                params.LaunchTemplateName = spec.LaunchTemplateName;
            } else {
                console.log(`ASG ${asgName} has launch template, but no ID or name`);
                continue;
            }

            // Get launch template version data
            const templateRes = await ec2.describeLaunchTemplateVersions(params).promise();
            const imageId = templateRes.LaunchTemplateVersions?.[0]?.LaunchTemplateData?.ImageId;

            if (!imageId) {
                console.log(`Could not determine AMI for ASG ${asgName}`);
                continue;
            }

            // Get the original AMI name
            const imageDetails = await ec2.describeImages({
                ImageIds: [imageId]
            }).promise();

            const originalName = imageDetails.Images?.[0]?.Name;     
            const now = new Date();
            const today = now.toISOString().split('T')[0]; // e.g., "2025-06-24"
            const time = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '-'); // e.g., "14-52-36"
            const cutoff = new Date(now.getTime() - 5 * 60 * 1000); 


            const amiName = `${originalName}-${today}-${time}`;



            console.log(`Copying AMI ${imageId} as "${amiName}" to ${TARGET_REGION}`);

            const copyImageRes = await ec2TargetRegion.copyImage({
                SourceImageId: imageId,
                SourceRegion: process.env.AWS_REGION,
                Name: amiName,
                Description: `Copied from ASG ${asgName} (AMI: ${imageId})`
            }).promise();


            console.log(`Copied AMI to ${TARGET_REGION}: ${copyImageRes.ImageId}`);
            console.log(` Copied AMI to ${TARGET_REGION}: ${copyImageRes.ImageId}`);

            const prefix = `${originalName}-`;
            const oldImages = await ec2TargetRegion.describeImages({
                Owners: ['self'],
                Filters: [
                    {
                        Name: 'name',
                        Values: [`${prefix}*`]
                    }
                ]
            }).promise();

            for (const image of oldImages.Images) {
                const creationDate = new Date(image.CreationDate);
                if (creationDate < cutoff) {
                    console.log(` Deregistering old AMI: ${image.ImageId} (${image.Name})`);
                    await ec2TargetRegion.deregisterImage({
                        ImageId: image.ImageId
                    }).promise();
                }
            }
        } catch (err) {
            console.error(`Failed to process ASG ${asgName}: ${err.message}`);
        }
    }
};
