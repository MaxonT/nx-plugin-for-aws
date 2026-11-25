/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  joinPathFragments,
  type MigrationReturnObject,
  type Tree,
} from '@nx/devkit';
import { formatFilesInSubtree } from '../../../utils/format.js';
import {
  migrateVendedFiles,
  type VendedEdit,
} from '../../../utils/migrate-vended-text.js';
import {
  PACKAGES_DIR,
  SHARED_CONSTRUCTS_DIR,
} from '../../../utils/shared-constructs-constants.js';
import { USER_IDENTITY_CALLBACK_URLS } from '../../../utils/vended-shapes.js';

/**
 * The vended UserIdentity permitted sign-in to return only to the local dev
 * servers and the stack's CloudFront distributions. It gains addCallbackUrl,
 * and permits the callback of any construct in the stack that names one as
 * `signInCallbackUrls`, as a website hosted through API Gateway does.
 *
 * Guardrails: GritQL checks for the shape this construct was generated with,
 * and the edits match its text, as a formatter may have left it. A construct that has diverged is reported through
 * `nextSteps` and left alone, and a migrated one no longer matches, so the
 * migration is idempotent.
 */
export const EDITS: VendedEdit[] = [
  {
    from: `  private createUserPoolClient = (userPool: UserPool) => {`,
    to: `  private readonly additionalCallbackUrls: string[] = [];

  /**
   * Permits the web client's sign-in and sign-out to redirect to the given URL,
   * in addition to the local dev servers and any CloudFront distributions in the stack.
   *
   * @param url - The full URL the app redirects to, such as a website served from a custom domain
   */
  public addCallbackUrl(url: string) {
    this.additionalCallbackUrls.push(url);
  }

  private createUserPoolClient = (userPool: UserPool) => {`,
  },
  {
    from: `        LOCAL_CALLBACK_URLS.concat(
          Stack.of(this)
            .node.findAll()
            .filter((child): child is Distribution => child instanceof Distribution)
            .flatMap(findCloudFrontDomainNames)
            .map((domain) => \`https://\${domain}\`)
        ),`,
    to: `        [
          ...new Set(
            LOCAL_CALLBACK_URLS.concat(this.additionalCallbackUrls)
              .concat(
                Stack.of(this)
                  .node.findAll()
                  .filter((child): child is Distribution => child instanceof Distribution)
                  .flatMap(findCloudFrontDomainNames)
                  .map((domain) => \`https://\${domain}\`)
              )
              // Websites served other than by CloudFront, such as through an API
              .concat(
                Stack.of(this)
                  .node.findAll()
                  .flatMap((child) => (child as { signInCallbackUrls?: unknown }).signInCallbackUrls)
                  .filter((url): url is string => typeof url === 'string')
              ),
          ),
        ],`,
  },
];

export default async function migration(
  tree: Tree,
): Promise<MigrationReturnObject> {
  const { nextSteps } = await migrateVendedFiles(
    tree,
    [
      joinPathFragments(
        PACKAGES_DIR,
        SHARED_CONSTRUCTS_DIR,
        'src',
        'core',
        'user-identity.ts',
      ),
    ],
    USER_IDENTITY_CALLBACK_URLS,
    EDITS,
    (path) =>
      `${path} has changed since it was generated, so it was left alone. A website hosted through API Gateway, or behind a Verified Access door, needs UserIdentity to permit its sign-in callback: add an addCallbackUrl(url) method that adds to the web client's callback URLs.`,
  );
  await formatFilesInSubtree(tree);
  return { nextSteps };
}
