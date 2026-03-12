import { spawn } from 'child_process';
import path from 'path';
import process from 'process';
import fse from '@zokugun/fs-extra-plus/async';
import {
	type AsyncDResult, err, OK, ok,
} from '@zokugun/xtry';
import vscode from 'vscode';
import { EDITOR_MODE, EditorMode } from './editor.js';

type Logger = {
	error: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
};

type Options = {
	binary?: string;
};

export async function restartApp(extensionName: string, logger: Logger, options?: Options): Promise<void> {
	if(EDITOR_MODE === EditorMode.Theia) {
		await vscode.window.showInformationMessage(
			`Source: ${extensionName}\n\nThe editor needs to be restarted before continuing. You need to do it manually. Thx`,
			{
				modal: true,
			},
		);
	}
	else {
		const file = path.join(vscode.env.appRoot, 'product.json');
		const productResult = await fse.readJSON(file);
		if(productResult.fails) {
			logger.error(`Cannot read "${file}"`);

			return;
		}

		const product = productResult.value as { nameLong: string; applicationName: string };

		const restartResult
			= process.platform === 'darwin' ? await restartMac(product)
				: (process.platform === 'win32' ? await restartWindows(product)
					: await restartLinux(product, options));

		if(restartResult.fails) {
			logger.error(restartResult.error);
		}
	}
}

async function restartMac({ nameLong, applicationName }: { nameLong: string; applicationName: string }): AsyncDResult {
	const match = /(.*\.app)\/Contents\/Frameworks\//.exec(process.execPath);
	const appPath = match ? match[1] : `/Applications/${nameLong}.app`;
	const binary = await searchBinary(`${appPath}/Contents/Resources/app/bin/`, applicationName);

	if(binary.fails) {
		return binary;
	}

	spawn('osascript', ['-e', `quit app "${nameLong}"`, '-e', 'delay 1', '-e', `do shell script quoted form of "${binary.value}"`], {
		detached: true,
		stdio: 'ignore',
	});

	return OK;
}

async function restartWindows({ applicationName }: { applicationName: string }): AsyncDResult {
	const appHomeDir = path.dirname(process.execPath);
	const exeName = path.basename(process.execPath);

	const binary = await searchBinary([
		path.join(appHomeDir, 'bin'),
		path.join(vscode.env.appRoot, 'bin'),
	], applicationName);

	if(binary.fails) {
		return binary;
	}

	spawn(process.env.comspec ?? 'cmd', [`/C taskkill /F /IM ${exeName} >nul && timeout /T 1 && "${binary.value}"`], {
		detached: true,
		stdio: 'ignore',
		windowsVerbatimArguments: true,
		windowsHide: true,
	});

	return OK;
}

async function restartLinux({ applicationName }: { applicationName: string }, options?: Options): AsyncDResult {
	if(path.basename(process.execPath) === 'electron') {
		let binary = options?.binary ?? '';

		if(!binary) {
			const paths = [path.join(vscode.env.appRoot, 'bin')];

			const parts = vscode.env.appRoot.split(path.sep);
			if(parts.pop() === 'app' && parts.pop() === 'resources') {
				paths.push(parts.join(path.sep));
			}

			const result = await searchBinary(paths, applicationName);
			if(result.fails) {
				return result;
			}

			binary = result.value;
		}

		const pid = process.env.VSCODE_PID;

		spawn('/bin/sh', ['-c', `kill -15 ${pid} && sleep 1 && (kill -9 ${pid} && sleep 1 || true) && "${binary}"`], {
			detached: true,
			stdio: 'ignore',
		});
	}
	else {
		const appHomeDir = path.dirname(process.execPath);
		const binary = await searchBinary([
			path.join(appHomeDir, 'bin'),
			path.join(vscode.env.appRoot, 'bin'),
		], applicationName);

		if(binary.fails) {
			return binary;
		}

		spawn('/bin/sh', ['-c', `killall "${process.execPath}" && sleep 1 && killall -9 "${process.execPath}" && sleep 1 && "${binary.value}"`], {
			detached: true,
			stdio: 'ignore',
		});
	}

	return OK;
}

async function searchAppBinary(appHomeDir: string, appName: string): AsyncDResult<string> {
	const result = await fse.readdir(appHomeDir);
	if(result.fails) {
		return err(`Cannot find binary for app "${appName}" in "${appHomeDir}"`);
	}

	let files = result.value;

	if(files.length === 1) {
		return ok(path.join(appHomeDir, files[0]));
	}

	// remove tunnel
	files = files.filter((file) => !file.includes('-tunnel'));

	if(files.length === 1) {
		return ok(path.join(appHomeDir, files[0]));
	}

	if(process.platform === 'win32') {
		// select *.cmd
		const cmdFiles = files.filter((file) => file.endsWith('.cmd') && file.toLowerCase().includes(appName.toLowerCase()));

		if(cmdFiles.length === 1) {
			return ok(path.join(appHomeDir, cmdFiles[0]));
		}
	}

	const binary = files.find((file) => file.toLowerCase().includes(appName.toLowerCase()));

	if(binary) {
		return ok(path.join(appHomeDir, binary));
	}

	return err(`Cannot find binary for app "${appName}" in "${appHomeDir}"`);
}

async function searchBinary(binPath: string | string[], appName: string): AsyncDResult<string> {
	if(Array.isArray(binPath)) {
		for(const path of binPath) {
			const binary = await searchAppBinary(path, appName);

			if(!binary.fails) {
				return binary;
			}
		}
	}
	else {
		const binary = await searchAppBinary(binPath, appName);

		if(!binary.fails) {
			return binary;
		}
	}

	return err(`Cannot find binary for app "${appName}" in "${JSON.stringify(binPath)}"`);
}
