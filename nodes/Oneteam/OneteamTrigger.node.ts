import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { WEBHOOK_EVENTS, WebhookEventType } from './events';
import {
	getOrganisation,
	listResourceOptions,
	oneteamApiRequest,
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
			{
				displayName: 'Form Name or ID',
				name: 'formId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getForms' },
				default: '',
				description:
					'Only trigger for this form. Leave empty to trigger for every form. Choose from the list, or specify an ID using an expression.',
				displayOptions: {
					show: { event: [WebhookEventType.FORM_SUBMISSION_CREATED] },
				},
			},
		],
	};

	methods = {
		loadOptions: {
			async getForms(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return listResourceOptions.call(this, 'forms', 'title');
			},
		},
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
					`/v1/organisations/${organisation.id}/webhooks`,
					{
						url: webhookUrl,
						events: [event],
						description: `n8n: ${event}`,
					},
				);
				const created = (response.data as IDataObject) ?? response;
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
						`/v1/organisations/${webhookData.organisationId}/webhooks/${webhookData.webhookId}`,
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

		if (event === WebhookEventType.FORM_SUBMISSION_CREATED) {
			const formId = this.getNodeParameter('formId', '') as string;
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
						`/v1/organisations/${organisation.id}/forms/${form.id}/submissions/${submission.id}`,
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
