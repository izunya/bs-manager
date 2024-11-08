import { IpcService } from "./ipc.service";
import { ProgressBarService } from "./progress-bar.service";
import { ModalService } from "renderer/services/modale.service";
import { ChangelogModal } from "renderer/components/modal/modal-types/chabgelog-modal/changelog-modal.component";
import { ConfigurationService } from "./configuration.service";
import { Observable, lastValueFrom } from "rxjs";
import { Progression } from "main/helpers/fs.helpers";


export interface Changelog {
    [version: string]: ChangelogVersion;
}
export interface ChangelogVersion {
    htmlBody: string;
    title: string;
    timestamp : number;
    version: string;
}
export class AutoUpdaterService {
    private static instance: AutoUpdaterService;

    private progressService: ProgressBarService;
    private ipcService: IpcService;

    private modal: ModalService;

    private configurationService: ConfigurationService;

    private cacheChangelog: Changelog;

    public static getInstance(): AutoUpdaterService {
        if (!AutoUpdaterService.instance) {
            AutoUpdaterService.instance = new AutoUpdaterService();
        }
        return AutoUpdaterService.instance;
    }

    private constructor() {
        this.progressService = ProgressBarService.getInstance();
        this.ipcService = IpcService.getInstance();
        this.modal = ModalService.getInstance();
        this.configurationService = ConfigurationService.getInstance();
    }

    public isUpdateAvailable(): Promise<boolean> {
        return lastValueFrom(this.ipcService.sendV2("check-update")).catch(() => false);
    }

    public downloadUpdate(): Observable<Progression> {
        return new Observable<Progression>(obs => {
            const download$ = this.ipcService.sendV2("download-update");
            this.progressService.show(download$);

            const sub = download$.subscribe(obs);

            return () => {
                sub.unsubscribe();
                this.progressService.hide();
            }
        });
    }

    public quitAndInstall(): Promise<void> {
        return lastValueFrom(this.ipcService.sendV2("install-update"));
    }

    public getLastAppVersion(): string {
        return this.configurationService.get("last-app-version");
    }

    public setLastAppVersion(value : string){
        this.configurationService.set("last-app-version", value);
    }

    private async getChangelog(): Promise<Changelog> {
        if (this.cacheChangelog) {
            return this.cacheChangelog;
        }

        const path = `https://raw.githubusercontent.com/Zagrios/bs-manager/master/assets/jsons/changelogs.json`
        const response = await fetch(path);
        if (!response.ok) {
            throw new Error(`Failed to fetch changelogs (${response.status})`);
        }

        const data = await response.json();
        if (!data) {
            throw new Error(`Failed to parse changelogs`);
        }

        this.cacheChangelog = data;
        return data;
    }

    private async getChangelogVersion(version:string): Promise<ChangelogVersion> {
        const changelogs = await this.getChangelog();

        const changelogVersion = changelogs[version];
        if (!changelogVersion) {
            throw new Error(`No changelog found for this version (${version})`);
        }

        return changelogVersion;
    }

    public getAppVersion() : Observable<string> {
        return this.ipcService.sendV2("current-version");
    }

    public async showChangelog(version:string): Promise<void>{
            if (version.toLowerCase().includes("alpha")) {
                throw new Error("Alpha version, skipping changelog");
            }

            const changelog = await this.getChangelogVersion(version);

            this.modal.openModal(ChangelogModal, {data: changelog});
    }
}
