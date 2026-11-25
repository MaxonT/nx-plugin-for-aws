/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  getProjects,
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
  COGNITO_AUTH_BASE_PATH,
  RUNTIME_CONFIG_BASE_PATH,
  SIGN_OUT_BASE_PATH,
} from '../../../utils/vended-shapes.js';

/**
 * A React website's vended RuntimeConfig, CognitoAuth and sign-out menu used
 * the root path, so a website built with a Vite `base` other than '/' loaded
 * the wrong config and returned from sign-in outside the app. CognitoAuth also
 * dropped the page a user opened when sending them to sign in.
 *
 * At the default base of '/' the redirects are unchanged, so a website hosted
 * on CloudFront behaves as before, apart from keeping deep links.
 *
 * Guardrails: GritQL checks for the shape these files were generated with, and
 * each edit matches their text, as a
 * formatter may have left it. A file that has diverged is reported through
 * `nextSteps` and left alone, and a migrated file no longer matches, so the
 * migration is idempotent.
 */

const BASE_AWARE_REDIRECT =
  "window.location.origin + new URL(import.meta.env.BASE_URL, document.baseURI).pathname.replace(/^\\/$/, '')";

export const RUNTIME_CONFIG_EDITS: VendedEdit[] = [
  {
    from: " * This assumes a runtime-config.json file is present at '/'.",
    to: " * This assumes a runtime-config.json file is present at the app's base path.",
    optional: true,
  },
  {
    from: "fetch('/runtime-config.json')",
    to: 'fetch(`${import.meta.env.BASE_URL}runtime-config.json`)',
  },
];

export const COGNITO_AUTH_EDITS: VendedEdit[] = [
  {
    from: " * This assumes a runtime-config.json file is present at '/'. In order for Auth to be set up automatically,",
    to: " * This assumes a runtime-config.json file is present at the app's base path. In order for Auth to be set up automatically,",
    optional: true,
  },
  {
    from: `    redirect_uri: window.location.origin,
    response_type: 'code',
    scope: 'email openid profile',`,
    to: `    // The app's base path, resolved against the page's base URL so a relative Vite base
    // works too, or just the origin when the app is served from '/'
    redirect_uri: ${BASE_AWARE_REDIRECT},
    response_type: 'code',
    scope: 'email openid profile',
    // Return to the page the user opened, held in the sign-in state, otherwise to the
    // page signed in to, without the sign-in's code and state
    onSigninCallback: (user) => {
      const returnTo = user?.state;
      window.history.replaceState(
        null,
        '',
        typeof returnTo === 'string' &&
          returnTo.startsWith(new URL(import.meta.env.BASE_URL, document.baseURI).pathname) &&
          !returnTo.startsWith('//')
          ? returnTo
          : window.location.pathname,
      );
    },`,
  },
  {
    from: '      auth.signinRedirect();',
    to: `      const { pathname, search, hash } = window.location;
      auth.signinRedirect({ state: \`\${pathname}\${search}\${hash}\` });`,
  },
];

export const SIGN_OUT_EDITS: VendedEdit[] = [
  {
    from: `post_logout_redirect_uri: window.location.origin,`,
    to: `post_logout_redirect_uri: ${BASE_AWARE_REDIRECT},`,
  },
  {
    from: `redirect_uri: window.location.origin,
            response_type: 'code',`,
    to: `redirect_uri: ${BASE_AWARE_REDIRECT},
            response_type: 'code',`,
  },
];

export default async function migration(
  tree: Tree,
): Promise<MigrationReturnObject> {
  const components = [...getProjects(tree).values()].map((project) =>
    joinPathFragments(
      project.sourceRoot ?? joinPathFragments(project.root, 'src'),
      'components',
    ),
  );
  const diverged = (path: string) =>
    `${path} has changed since it was generated, so it was left alone. If the website is served under a base path, make its runtime config fetch and sign-in redirects use import.meta.env.BASE_URL.`;
  const nextSteps = [
    ...(
      await migrateVendedFiles(
        tree,
        components.map((dir) =>
          joinPathFragments(dir, 'RuntimeConfig', 'index.tsx'),
        ),
        RUNTIME_CONFIG_BASE_PATH,
        RUNTIME_CONFIG_EDITS,
        diverged,
      )
    ).nextSteps,
    ...(
      await migrateVendedFiles(
        tree,
        components.map((dir) =>
          joinPathFragments(dir, 'CognitoAuth', 'index.tsx'),
        ),
        COGNITO_AUTH_BASE_PATH,
        COGNITO_AUTH_EDITS,
        diverged,
      )
    ).nextSteps,
    ...(
      await migrateVendedFiles(
        tree,
        // Only an AppLayout that has a sign-out menu, as the auth generator adds
        components
          .map((dir) => joinPathFragments(dir, 'AppLayout', 'index.tsx'))
          .filter((path) =>
            (tree.read(path, 'utf-8') ?? '').includes('signoutRedirect('),
          ),
        SIGN_OUT_BASE_PATH,
        SIGN_OUT_EDITS,
        diverged,
      )
    ).nextSteps,
  ];
  await formatFilesInSubtree(tree);
  return { nextSteps };
}
