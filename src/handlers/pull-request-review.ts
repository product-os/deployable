import type { Context } from 'probot';
import type {
	PullRequestReviewSubmittedEvent,
	WorkflowRun,
} from '@octokit/webhooks-types';
import * as GitHubClient from '../client.js';

export async function handlePullRequestReview(context: Context) {
	const { review } = context.payload as PullRequestReviewSubmittedEvent;

	const eventDetails = {
		review: {
			id: review.id,
			body: review.body,
			commit_id: review.commit_id,
			user: {
				id: review.user.id,
				login: review.user.login,
			},
		},
	};

	context.log.info(
		'Received pull request review event: %s',
		JSON.stringify(eventDetails, null, 2),
	);

	if (!['approved', 'commented'].includes(review.state.toLowerCase())) {
		context.log.debug('Ignoring unsupported review state: %s', review.state);
		return;
	}

	if (!review.body?.startsWith('/deploy')) {
		context.log.debug('Ignoring unsupported comment');
		return;
	}

	if (review.user.type === 'Bot') {
		context.log.debug('Ignoring review by Bot: %s', review.user.login);
		return;
	}

	const workflowRuns = await GitHubClient.listWorkflowRuns(
		context,
		review.commit_id,
	);

	await Promise.all(
		workflowRuns
			.filter((workflowRun) => workflowRun.actor.id !== review.user.id)
			.map(async (workflowRun: WorkflowRun) => {
				const pendingDeployments = await GitHubClient.listPendingDeployments(
					context,
					workflowRun.id,
				);

				if (pendingDeployments.length === 0) {
					context.log.info(
						'No pending deployments found for workflow run %s',
						workflowRun.id,
					);
					return;
				}

				const environmentNames = pendingDeployments
					.filter((deployment) => deployment.current_user_can_approve)
					.filter((deployment) => deployment.environment.name !== undefined)
					.map((deployment) => deployment.environment.name!);

				await Promise.all(
					environmentNames.map((environmentName) =>
						GitHubClient.reviewWorkflowRun(
							context,
							workflowRun.id,
							environmentName,
							'approved',
							`Approved by ${review.user.login} via [review](${review.html_url})`,
						),
					),
				);
			}),
	);
}
