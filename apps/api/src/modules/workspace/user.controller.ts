import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  CreateUserDto,
  InviteUserDto,
  QueryUserDto,
  ResetPasswordDto,
  UpdateUserDto,
  UpdateUserRolesDto,
  UpdateUserStatusDto,
} from './dto/user.dto';
import { RoleView, UserPage, UserService, UserView } from './user.service';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Roles('owner', 'admin')
  @Get()
  list(@Query() query: QueryUserDto): Promise<UserPage> {
    return this.userService.list(query);
  }

  @Roles('owner', 'admin')
  @Get('roles')
  roles(): Promise<RoleView[]> {
    return this.userService.listRoles();
  }

  @Roles('owner', 'admin')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<UserView> {
    return this.userService.get(id);
  }

  @Roles('owner', 'admin')
  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() user?: AuthUser) {
    return this.userService.create(dto, toActor(user));
  }

  @Roles('owner', 'admin')
  @Post('invite')
  invite(@Body() dto: InviteUserDto, @CurrentUser() user?: AuthUser) {
    return this.userService.invite(dto, toActor(user));
  }

  @Roles('owner', 'admin')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() user?: AuthUser): Promise<UserView> {
    return this.userService.update(id, dto, toActor(user));
  }

  @Roles('owner')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser) {
    return this.userService.remove(id, toActor(user));
  }

  @Roles('owner')
  @Patch(':id/roles')
  updateRoles(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserRolesDto, @CurrentUser() user?: AuthUser): Promise<UserView> {
    return this.userService.updateRoles(id, dto.roleCodes, toActor(user));
  }

  @Roles('owner', 'admin')
  @Patch(':id/reset-password')
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto, @CurrentUser() user?: AuthUser) {
    return this.userService.resetPassword(id, toActor(user), dto.newPassword);
  }

  @Roles('owner', 'admin')
  @Patch(':id/status')
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserStatusDto, @CurrentUser() user?: AuthUser): Promise<UserView> {
    return this.userService.updateStatus(id, dto, toActor(user));
  }
}
