import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { WEBHOOK_EVENTS, WebhookEventType } from './events';
import {
	apiRecord,
	formAndCourseSearch,
	getOrganisation,
	oneteamApiRequest,
	organisationPath,
	searchLocator,
} from './GenericFunctions';

type WebhookStaticData = {
	webhookId?: string;
	organisationId?: string;
};

export class OneteamTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Oneteam Trigger',
		name: 'oneteamTrigger',
		icon: 'file:oneteam.png',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow when an Oneteam webhook event is received',
		defaults: {
			name: 'Oneteam Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'oneteamApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				options: WEBHOOK_EVENTS.map((definition) => ({
					name: definition.name,
					value: definition.event,
					description: definition.description,
				})),
				default: WebhookEventType.USER_INVITED,
				required: true,
			},
			searchLocator('Form Name or ID', 'formId', 'searchForms', {
				required: false,
				idPlaceholder: 'Form ID',
				description:
					'Only trigger for this form. Leave empty to trigger for every form. Search by title (3+ characters), or paste an ID.',
				displayOptions: {
					show: { event: [WebhookEventType.FORM_SUBMISSION_CREATED] },
				},
			}),
			searchLocator('Course Name or ID', 'courseId', 'searchCourses', {
				required: false,
				idPlaceholder: 'Course ID',
				description:
					'Only trigger for this course. Leave empty to trigger for every course. Search by name, or paste an ID.',
				displayOptions: {
					show: { event: [WebhookEventType.COURSE_COMPLETED] },
				},
			}),
		],
	};

	methods = {
		listSearch: formAndCourseSearch,
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData(
					'node',
				) as WebhookStaticData;

				return Boolean(webhookData.webhookId);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const event = this.getNodeParameter('event') as string;
				const organisation = await getOrganisation.call(this);
				const response = await oneteamApiRequest.call(
					this,
					'POST',
					organisationPath(organisation.id, 'webhooks'),
					{
						url: webhookUrl,
						events: [event],
						description: `n8n: ${event}`,
					},
				);
				const created = apiRecord(response);
				const webhookData = this.getWorkflowStaticData(
					'node',
				) as WebhookStaticData;

				webhookData.webhookId = String(created.id);
				webhookData.organisationId = organisation.id;

				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData(
					'node',
				) as WebhookStaticData;

				if (!webhookData.webhookId || !webhookData.organisationId) {
					return true;
				}

				try {
					await oneteamApiRequest.call(
						this,
						'DELETE',
						organisationPath(
							webhookData.organisationId,
							`webhooks/${webhookData.webhookId}`,
						),
					);
				} catch {
					// Already gone is a successful unsubscribe.
				}

				delete webhookData.webhookId;
				delete webhookData.organisationId;

				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const envelope = this.getBodyData();
		const event = this.getNodeParameter('event') as string;

		if (envelope.type && envelope.type !== event) {
			return { noWebhookResponse: true };
		}

		if (event === WebhookEventType.COURSE_COMPLETED) {
			const courseId = this.getNodeParameter('courseId', '', {
				extractValue: true,
			}) as string;
			const data = envelope.data as IDataObject | undefined;
			const course = data?.course as IDataObject | undefined;

			if (courseId && String(course?.id) !== String(courseId)) {
				return { noWebhookResponse: true };
			}
		}

		if (event === WebhookEventType.FORM_SUBMISSION_CREATED) {
			const formId = this.getNodeParameter('formId', '', {
				extractValue: true,
			}) as string;
			const data = envelope.data as IDataObject | undefined;
			const form = data?.form as IDataObject | undefined;

			if (formId && String(form?.id) !== String(formId)) {
				return { noWebhookResponse: true };
			}

			const submission = data?.submission as IDataObject | undefined;
			const organisation = await getOrganisation.call(this);

			if (form?.id && submission?.id) {
				try {
					const detail = await oneteamApiRequest.call(
						this,
						'GET',
						organisationPath(
							organisation.id,
							`forms/${form.id}/submissions/${submission.id}`,
						),
					);

					return {
						workflowData: [
							this.helpers.returnJsonArray({
								...envelope,
								submission_detail: detail.data ?? null,
							}),
						],
					};
				} catch {
					// Thin envelope is still useful if hydration fails.
				}
			}
		}

		return {
			workflowData: [this.helpers.returnJsonArray(envelope)],
		};
	}
}
