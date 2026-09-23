import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

type OneteamContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

export type Organisation = {
	id: string;
	name: string;
};

export async function oneteamApiRequest(
	this: OneteamContext,
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<IDataObject> {
	const credentials = await this.getCredentials('oneteamApi');
	const baseUrl = String(credentials.baseUrl ?? '').replace(/\/$/, '');

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'oneteamApi',
			{
				method,
				url: `${baseUrl}${path}`,
				body: Object.keys(body).length ? body : undefined,
				qs: Object.keys(qs).length ? qs : undefined,
				arrayFormat: 'brackets',
				json: true,
			},
		)) as IDataObject;
	} catch (error) {
		const statusCode = readStatusCode(error);
		const detail = readErrorDetail(error);

		if (statusCode === 429) {
			throw new NodeOperationError(
				this.getNode(),
				'Oneteam rate limit reached. Wait a moment and try again.',
			);
		}

		if (statusCode === 401) {
			throw new NodeOperationError(
				this.getNode(),
				detail ??
					'Your Oneteam token is invalid or revoked. Open credentials and paste a new service account token from Organisation Settings → Service Accounts.',
			);
		}

		if (statusCode === 403) {
			throw new NodeOperationError(
				this.getNode(),
				permissionErrorMessage(detail, path),
			);
		}

		if (isInvalidCursorError(detail)) {
			throw new NodeOperationError(
				this.getNode(),
				'Invalid pagination cursor. Copy the Next Page value from the nextPage column of the previous run output table, or leave Next Page empty to start from the first page.',
			);
		}

		if (detail) {
			throw new NodeOperationError(this.getNode(), detail);
		}

		if (statusCode !== undefined) {
			throw new NodeOperationError(
				this.getNode(),
				`Oneteam API request failed (${statusCode}).`,
			);
		}

		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

function readStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;

	const record = error as Record<string, unknown>;
	const response = record.response as Record<string, unknown> | undefined;
	const body = record.error as Record<string, unknown> | undefined;
	const candidates = [
		record.statusCode,
		record.httpCode,
		response?.statusCode,
		response?.status,
		body?.status_code,
	];

	for (const candidate of candidates) {
		const code = Number(candidate);
		if (Number.isFinite(code) && code >= 400) return code;
	}

	return undefined;
}

function readErrorDetail(error: unknown): string | undefined {
	if (!error || typeof error !== 'object') return undefined;

	const record = error as Record<string, unknown>;
	const response = record.response as Record<string, unknown> | undefined;
	const cause = record.cause as Record<string, unknown> | undefined;
	const causeResponse = cause?.response as Record<string, unknown> | undefined;
	const bodies = [
		record.error,
		response?.body,
		response?.data,
		causeResponse?.body,
		causeResponse?.data,
	];

	for (const body of bodies) {
		const parsed = parseErrorBody(body);
		if (!parsed) continue;

		const detail = parsed.detail;
		const message = parsed.message;
		const errorField = parsed.error;

		if (typeof detail === 'string' && detail.trim()) return detail.trim();
		if (typeof message === 'string' && message.trim()) return message.trim();
		if (typeof errorField === 'string' && errorField.trim()) {
			return errorField.trim();
		}
	}

	return undefined;
}

function parseErrorBody(
	body: unknown,
): Record<string, unknown> | undefined {
	if (!body) return undefined;

	if (typeof body === 'string') {
		try {
			const parsed = JSON.parse(body) as unknown;
			if (parsed && typeof parsed === 'object') {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return undefined;
		}

		return undefined;
	}

	if (typeof body === 'object') {
		return body as Record<string, unknown>;
	}

	return undefined;
}

function isInvalidCursorError(detail: string | undefined): boolean {
	return detail !== undefined && /pagination cursor/i.test(detail);
}

function permissionErrorMessage(
	detail: string | undefined,
	path: string,
): string {
	const where =
		'Add it on the service account in Oneteam under Organisation Settings → Service Accounts, then paste a new token into the credential.';

	if (/\/forms\/?$/.test(path) || /\/courses\/?$/.test(path)) {
		return 'Listing forms and courses does not need an extra scope. This token cannot list them for this organisation. Use an organisation service account token.';
	}

	const scope = scopeForPath(path);
	if (scope) {
		return `This action needs the ${scope} scope. ${where}`;
	}

	if (detail && /network/i.test(detail)) return detail;

	if (detail && /scope|service account/i.test(detail)) return detail;

	return `This service account does not have permission for this action. ${where}`;
}

function scopeForPath(path: string): string | undefined {
	if (/\/forms\/[^/]+\/submissions/.test(path)) return 'forms.view-report';
	if (/\/courses\/[^/]+\/(statistics|feedback)/.test(path)) {
		return 'academy-courses.statistics';
	}
	if (/\/onboarding\/statistics/.test(path)) return 'onboarding.statistics';
	if (/\/analytics|\/metrics\//.test(path)) return 'analytics.view';
	if (/\/surveys/.test(path)) return 'surveys.view-report';
	if (/\/performance\/reports/.test(path)) {
		return 'performance-review-evaluations.view-all';
	}
	if (/\/organisation_messages/.test(path)) return 'organisation-messages.create';
	if (/\/webhooks/.test(path)) return 'webhooks.manage';
	if (/\/users/.test(path)) return 'users.manage';
	return undefined;
}

export async function getOrganisation(
	this: OneteamContext,
): Promise<Organisation> {
	const response = await oneteamApiRequest.call(
		this,
		'GET',
		'/v1/organisations',
	);
	const organisations = (response.data as Organisation[]) ?? [];

	if (organisations.length === 0) {
		throw new NodeOperationError(
			this.getNode(),
			'This token has no organisation. Create a service account token in Oneteam under Organisation Settings.',
		);
	}

	if (organisations.length > 1) {
		throw new NodeOperationError(
			this.getNode(),
			'This token can access multiple organisations. Use an organisation service account token instead of a personal token.',
		);
	}

	return organisations[0];
}

export async function listResourceOptions(
	this: ILoadOptionsFunctions,
	path: string,
	nameField: 'name' | 'title',
	apiVersion: 'v1' | 'v2' = 'v2',
): Promise<Array<{ name: string; value: string }>> {
	const organisation = await getOrganisation.call(this);
	const rows = await listAllPages.call(
		this,
		`/${apiVersion}/organisations/${organisation.id}/${path}`,
	);

	return rows.map((row) => ({
		name: String(row[nameField] ?? row.id),
		value: String(row.id),
	}));
}

export async function listAllPages(
	this: OneteamContext,
	path: string,
	qs: IDataObject = {},
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	do {
		const page = await listPage.call(this, path, qs, cursor);
		rows.push(...page.rows);
		if (!page.nextPage || seenCursors.has(page.nextPage)) break;
		seenCursors.add(page.nextPage);
		cursor = page.nextPage;
	} while (cursor);

	return rows;
}

export async function listPage(
	this: OneteamContext,
	path: string,
	qs: IDataObject = {},
	cursor?: string,
): Promise<{ rows: IDataObject[]; nextPage: string }> {
	const response = await oneteamApiRequest.call(
		this,
		'GET',
		path,
		{},
		cursor ? { ...qs, cursor } : qs,
	);
	const meta = response.meta as IDataObject | undefined;
	const pagination = meta?.pagination as IDataObject | undefined;
	const nextCursor = pagination?.next_cursor;

	return {
		rows: (response.data as IDataObject[]) ?? [],
		nextPage: typeof nextCursor === 'string' ? nextCursor : '',
	};
}
