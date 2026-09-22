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
				permissionErrorMessage(detail),
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

function permissionErrorMessage(detail: string | undefined): string {
	const guidance =
		'Add the missing scope in Oneteam under Organisation Settings → Service Accounts.';

	if (!detail) {
		return `This service account does not have permission for this action. ${guidance}`;
	}

	if (/service account|scope/i.test(detail)) return detail;

	return `${detail} ${guidance}`;
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

async function listAllPages(
	this: OneteamContext,
	path: string,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	do {
		const response = await oneteamApiRequest.call(
			this,
			'GET',
			path,
			{},
			cursor ? { cursor } : {},
		);
		rows.push(...((response.data as IDataObject[]) ?? []));

		const meta = response.meta as IDataObject | undefined;
		const pagination = meta?.pagination as IDataObject | undefined;
		const nextCursor = pagination?.next_cursor;
		if (
			typeof nextCursor !== 'string' ||
			nextCursor.length === 0 ||
			seenCursors.has(nextCursor)
		) {
			cursor = undefined;
		} else {
			seenCursors.add(nextCursor);
			cursor = nextCursor;
		}
	} while (cursor);

	return rows;
}
