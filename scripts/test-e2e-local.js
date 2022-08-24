/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

'use strict';

/*
 * This script is a re-interpretation of the old test-manual.e2e.sh script.
 * the idea is to provide a better DX for the manual testing.
 * It's using Javascript over Bash for consistency with the rest of the recent scripts
 * and to make it more accessible for other devs to play around with.
 */

const {exec, exit, pushd, popd, pwd, cd} = require('shelljs');
const yargs = require('yargs');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  launchAndroidEmulator,
  isPackagerRunning,
  launchPackagesInSeparateWindow,
} = require('./testing-utils');

const {generateAndroidArtifacts} = require('./release-utils');

// setting this just 'cause this https://github.com/facebook/react-native/commit/0a3ca80af401654896cbc73e235711eef0f9b3c5
// breaks a bunch of stuff. This should be enough.
// TODO: follow up with Nicola in understanding the impact of the commit, and if we can remove this
// also, remove the folder
process.env.TMP_PUBLISH_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'rn-publish-'),
);
console.info(`The temp folder is ${process.env.TMP_PUBLISH_DIR}`);

const argv = yargs
  .option('t', {
    alias: 'target',
    default: 'RNTester',
    choices: ['RNTester', 'RNTestProject'],
  })
  .option('p', {
    alias: 'platform',
    default: 'iOS',
    choices: ['iOS', 'Android'],
  })
  .option('h', {
    alias: 'hermes',
    type: 'boolean',
    default: true,
  }).argv;

/*
 * see the test-local-e2e.js script for clean up process
 */

// command order: we ask the user to select if they want to test RN tester
// or RNTestProject

// if they select RN tester, we ask if iOS or Android, and then we run the tests
// if they select RNTestProject, we run the RNTestProject test

// let's check if Metro is already running, if it is let's kill it and start fresh
if (isPackagerRunning() === 'running') {
  exec("lsof -i :8081 | grep LISTEN | /usr/bin/awk '{print $2}' | xargs kill");
}

if (argv.target === 'RNTester') {
  //FIXME: make sure that the commands retains colors
  // (--ansi) doesn't always work
  // see also https://github.com/shelljs/shelljs/issues/86

  if (argv.platform === 'iOS') {
    console.info("We're going to test the Hermes version of RNTester iOS");
    exec(
      `cd packages/rn-tester && USE_HERMES=${
        argv.hermes ? 1 : 0
      } bundle exec pod install --ansi`,
    );

    // if everything succeeded so far, we can launch Metro and the app
    // start the Metro server in a separate window
    launchPackagesInSeparateWindow();

    // launch the app on iOS simulator
    pushd('packages/rn-tester');
    exec('npx react-native run-ios --scheme RNTester');
    popd();
  } else {
    // we do the android path here

    launchAndroidEmulator();

    if (argv.hermes) {
      console.info(
        "We're going to test the Hermes version of RNTester Android",
      );
      exec(
        './gradlew :packages:rn-tester:android:app:installHermesDebug --quiet',
      );
    } else {
      console.info("We're going to test the JSC version of RNTester Android");
      exec('./gradlew :packages:rn-tester:android:app:installJscDebug --quiet');
    }

    // if everything succeeded so far, we can launch Metro and the app
    // start the Metro server in a separate window
    launchPackagesInSeparateWindow();
    // just to make sure that the Android up won't have troubles finding the Metro server
    exec('adb reverse tcp:8081 tcp:8081');
    // launch the app
    exec(
      'adb shell am start -n com.facebook.react.uiapp/com.facebook.react.uiapp.RNTesterActivity',
    );
  }
} else {
  console.info("We're going to test a fresh new RN project");

  // create the local npm package to feed the CLI

  // we need to add the unique timestamp to avoid npm/yarn to use some local caches
  const baseVersion = require('../package.json').version;

  const dateIdentifier = new Date()
    .toISOString()
    .slice(0, -8)
    .replace(/[-:]/g, '')
    .replace(/[T]/g, '-');

  const releaseVersion = `${baseVersion}-${dateIdentifier}`;

  // need to put it into into a try finally to ensure that we clean up the state
  try {
    // this is needed to generate the Android artifacts correctly
    exec(`node scripts/set-rn-version.js --to-version ${releaseVersion}`).code;

    // Generate native files (Android only for now)
    generateAndroidArtifacts(releaseVersion);

    // create locally the node module
    exec('npm pack');

    const localNodeTGZPath = `${pwd()}/react-native-${releaseVersion}.tgz`;
    exec(`node scripts/set-rn-template-version.js "file:${localNodeTGZPath}"`);

    const repoRoot = pwd();

    pushd('/tmp/');
    // need to avoid the pod install step because it will fail! (see above)
    exec(
      `node ${repoRoot}/cli.js init RNTestProject --template ${repoRoot} --skip-install`,
    );

    cd('RNTestProject');
    exec('yarn install');

    if (argv.platform === 'iOS') {
      // if we want iOS, we need to do pod install - but with a trick
      cd('ios');
      exec('bundle install');

      // TODO: we should be able to also use HERMES_ENGINE_TARBALL_PATH
      // if we can make RNTester step generate it already so that it gets reused

      // need to discern if it's main branch or release branch
      if (baseVersion === '1000.0.0') {
        // main branch
        exec(
          `USE_HERMES=${argv.hermes ? 1 : 0} bundle exec pod install --ansi`,
        );
      } else {
        // a release branch
        // copy over the .hermesversion file from react-native core into the RNTestProject
        exec(`cp -f ${repoRoot}/sdks/.hermesversion .`);
        exec(
          `CI=true USE_HERMES=${
            argv.hermes ? 1 : 0
          } bundle exec pod install --ansi`,
        );
      }
      cd('..');
      exec('yarn ios');
    } else {
      // android
      exec('yarn android');
    }
    popd();
  } finally {
    // at the end here I most likely want to set back the rn version to baseVersion!
    // for git "cleanness" reasons
    exec(`node scripts/set-rn-template-version.js ${baseVersion}`);
  }
}

exit(0);
