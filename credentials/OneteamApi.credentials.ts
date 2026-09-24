import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class OneteamApi implements ICredentialType {
	name = 'oneteamApi';

	displayName = 'Oneteam API';

	documentationUrl = 'https://api.oneteam.io/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'Service Account Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Create a token in Oneteam under Organisation Settings → Service Accounts. It starts with sa_ and is shown once. Typical scopes: webhooks.manage, forms.view-report, forms.create, forms.update-submission, users.create, users.view, users.manage, organisation-messages.create, onboarding.statistics, analytics.view, tasks.create, tasks.update, notifications.send, chat-messages.create. Listing forms and courses does not need an extra scope. Reading form answers still needs forms.view-report.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.oneteam.io',
			description: 'Override for staging. Production is https://api.oneteam.io.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
				Accept: 'application/json',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/organisations',
		},
	};
}
