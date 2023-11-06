import { Observable, ReplaySubject, catchError, lastValueFrom, of, take, timeout } from "rxjs";
import { StoreLauncherInterface } from "./store-launcher.interface";
import { BSLaunchError, BSLaunchEvent, BSLaunchEventData, LaunchOption } from "../../../shared/models/bs-launch";
import { OculusService } from "../oculus.service";
import { BS_EXECUTABLE, OCULUS_BS_BACKUP_DIR, OCULUS_BS_DIR } from "../../constants";
import path from "path";
import log from "electron-log";
import { sToMs } from "../../../shared/helpers/time.helpers";
import { pathExists, readdir, rename, symlink, unlink } from "fs-extra";
import { AbstractLauncherService } from "./abstract-launcher.service";
import { taskRunning } from "../../helpers/os.helpers";
import { isJunction } from "../../helpers/fs.helpers";
import { CustomError } from "../../../shared/models/exceptions/custom-error.class";

export class OculusLauncherService extends AbstractLauncherService implements StoreLauncherInterface {

    public static instance: OculusLauncherService;

    public static getInstance(): OculusLauncherService {
        if (!OculusLauncherService.instance) {
            OculusLauncherService.instance = new OculusLauncherService();
        }
        return OculusLauncherService.instance;
    }

    private readonly oculus: OculusService;

    private readonly oculusLib$ = new ReplaySubject<string>();

    private constructor() {
        super();
        this.oculus = OculusService.getInstance();

        this.oculus.tryGetGameFolder([OCULUS_BS_DIR, OCULUS_BS_BACKUP_DIR]).then(async dirPath => {
            if(dirPath){ return this.oculusLib$.next( path.join(dirPath, "..") ); }
            const defaultLib = ((await this.oculus.getOculusLibs()) || []).find(lib => lib.isDefault);
            if(defaultLib?.path){ return this.oculusLib$.next(path.join(defaultLib.path, "Software")); }
            this.oculusLib$.next(null);
        }).catch(err => {
            log.error("Error while getting Oculus libs", err);
            this.oculusLib$.next(null);
        });
    }

    public async deleteBsSymlinks(): Promise<void> {
        const oculusLibPath = await lastValueFrom(this.oculusLib$.pipe(take(1), timeout(sToMs(30)), catchError(() => of(null))));

        if(!oculusLibPath || !(await pathExists(oculusLibPath))){
            throw new Error("Oculus library not found, deleteBsSymlinks"); 
        }

        const libContents = await readdir(oculusLibPath, { withFileTypes: true});
        const junctions = (await Promise.all(libContents.map(async dirent => {
            return (await isJunction(path.join(oculusLibPath, dirent.name))) ? dirent : null;
        }))).filter(Boolean);

        const bsSymlinks = junctions.filter(dirent => dirent.name.startsWith(OCULUS_BS_DIR));
        
        // get only symlinks created by BSM (with metadata.config)
        const bsmSymlinks = (await Promise.all(bsSymlinks.map(async symlink => {
            const symlinkPath = path.join(oculusLibPath, symlink.name);
            const symlinkContents = await readdir(symlinkPath);
            if(!symlinkContents.includes("metadata.config")){
                return null;
            }
            return symlink;
        }))).filter(Boolean);

        await Promise.all(bsmSymlinks.map(symlink => {
            return unlink(path.join(oculusLibPath, symlink.name));
        }));
    }

    private async backupOriginalBeatSaber(): Promise<void>{
        const bsFolder = await this.oculus.getGameFolder(OCULUS_BS_DIR);
        if(!bsFolder){ return; }
        const backupPath = path.join(bsFolder, "..", OCULUS_BS_BACKUP_DIR);
        return rename(bsFolder, backupPath);
    }

    public async restoreOriginalBeatSaber(): Promise<void>{
        const bsFolderBackupPath = await this.oculus.getGameFolder(OCULUS_BS_BACKUP_DIR);
        if(!(await pathExists(bsFolderBackupPath))){ return; }
        const originalPath = path.join(bsFolderBackupPath, "..", OCULUS_BS_DIR);
        return rename(bsFolderBackupPath, originalPath);
    }

    public launch(launchOptions: LaunchOption): Observable<BSLaunchEventData> {

        const prepareOriginalVersion: () => Promise<string> = async () => {
            await this.restoreOriginalBeatSaber();
            const bsPath = this.oculus.getGameFolder(OCULUS_BS_DIR);
            if(!bsPath){
                throw new Error("Oculus Beat Saber path not found");
            }
            return bsPath;
        }

        const prepareDowngradedVersion: () => Promise<string> = async () => {

            const oculusLib = await lastValueFrom(this.oculusLib$.pipe(take(1), timeout(sToMs(30)), catchError(() => of(null))));

            if(!oculusLib){
                throw new Error("No Oculus library found");
            }

            // Backup original Beat Saber folder
            await this.backupOriginalBeatSaber();

            // Create symlink in the oculus library from the BSM BS version
            const symlinkTarget = await this.localVersions.getInstalledVersionPath(launchOptions.version);
            const symlinkPath = path.join(oculusLib, OCULUS_BS_DIR);
            await symlink(symlinkTarget, symlinkPath, "junction");

            return symlinkPath;
        }

        return new Observable<BSLaunchEventData>(obs => {
            (async () => {

                // Cannot start multiple instances of Beat Saber with Oculus
                const bsRunning = await taskRunning(BS_EXECUTABLE).catch(() => false);
                if(bsRunning){
                    throw CustomError.fromError(new Error("Cannot start two instance of Beat Saber for Oculus"), BSLaunchError.BS_ALREADY_RUNNING);
                }
                
                // Remove previously symlinks created by BSM
                await this.deleteBsSymlinks().catch(err => log.error("Error while deleting BSM symlinks", err));

                const bsPath = await (launchOptions.version.oculus ? prepareOriginalVersion() : prepareDowngradedVersion())
                    .catch(err => CustomError.throw(err, BSLaunchError.OCULUS_LIB_NOT_FOUND));

                // Launch Beat Saber
                const exePath = path.join(bsPath, BS_EXECUTABLE);

                if(!(await pathExists(exePath))){
                    throw CustomError.fromError(new Error(`BS Path not exist ${bsPath}`), BSLaunchError.BS_NOT_FOUND);
                }

                obs.next({type: BSLaunchEvent.BS_LAUNCHING});
                return this.launchBs(exePath, this.buildBsLaunchArgs(launchOptions)).catch(err => {
                    throw CustomError.fromError(err, BSLaunchError.BS_EXIT_ERROR);
                });

            })().then(exitCode => {
                log.info("BS process exit code", exitCode);
            }).catch(err => {
                if(err instanceof CustomError){
                    obs.error(err);
                } else {
                    obs.error(CustomError.fromError(err, BSLaunchError.UNKNOWN_ERROR));
                }
            }).finally(() => {
                obs.complete();
            })
        });
    }

}